#!/usr/bin/env bash
# ============================================================================
# TEARDOWN SCRIPT
# ============================================================================
# Removes OpenClaw deployment and namespace.
#
# Usage:
#   ./teardown.sh                    # Teardown OpenShift (default)
#   ./teardown.sh --k8s              # Teardown vanilla Kubernetes
#   ./teardown.sh --env-file path    # Use a specific .env file (default: .env)
#   ./teardown.sh --delete-env       # Also delete .env file
#
# This script:
#   - Reads .env for namespace and prefix configuration
#   - Deletes all resources in namespace before deleting namespace
#     (avoids finalizer hang during namespace deletion)
#   - Removes cluster-scoped OAuthClients and A2A ClusterRoleBindings (OpenShift only)
#   - Strips finalizers from stuck namespaces
#   - Removes generated/ directory
#   - Optionally deletes .env
#
# If .env doesn't exist, you can set OPENCLAW_NAMESPACE manually:
#   OPENCLAW_NAMESPACE=my-openclaw ./teardown.sh
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Parse flags
K8S_MODE=false
DELETE_ENV=false
ENV_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --k8s) K8S_MODE=true; shift ;;
    --delete-env) DELETE_ENV=true; shift ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    *) shift ;;
  esac
done
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env}"

if $K8S_MODE; then
  KUBECTL="kubectl"
else
  KUBECTL="oc"
fi

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()    { echo -e "${BLUE}ℹ️  $1${NC}"; }
log_success() { echo -e "${GREEN}✅ $1${NC}"; }
log_warn()    { echo -e "${YELLOW}⚠️  $1${NC}"; }
log_error()   { echo -e "${RED}❌ $1${NC}"; }

echo ""
echo "╔════════════════════════════════════════════════════════════╗"
echo "║  OpenClaw Teardown                                         ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""

# Load .env if available
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
fi

# Determine namespace — env var takes precedence, then .env, then prompt
if [ -z "${OPENCLAW_NAMESPACE:-}" ]; then
  log_warn "No .env file and OPENCLAW_NAMESPACE not set."
  read -p "  Enter OpenClaw namespace to teardown (e.g., sallyom-openclaw): " OPENCLAW_NAMESPACE
  if [ -z "$OPENCLAW_NAMESPACE" ]; then
    log_error "Namespace is required."
    exit 1
  fi
fi

echo "Namespace to teardown:"
echo "  - $OPENCLAW_NAMESPACE"
echo ""

read -p "Continue? (y/N): " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  log_info "Teardown cancelled"
  exit 0
fi
echo ""

# Delete all resources in a namespace before deleting the namespace itself.
# This avoids the common issue where namespace deletion hangs on finalizers.
teardown_namespace() {
  local ns="$1"

  if ! $KUBECTL get namespace "$ns" &>/dev/null; then
    log_warn "Namespace $ns does not exist — skipping"
    return 0
  fi

  log_info "Deleting resources in $ns..."

  # Workloads and services (oc delete all covers deployments, replicasets,
  # pods, services, daemonsets, statefulsets, replicationcontrollers, buildconfigs, builds, imagestreams)
  $KUBECTL delete all --all -n "$ns" --timeout=60s 2>/dev/null || true

  # Jobs (not included in 'all')
  $KUBECTL delete jobs --all -n "$ns" --timeout=30s 2>/dev/null || true
  $KUBECTL delete cronjobs --all -n "$ns" --timeout=30s 2>/dev/null || true

  # Config and secrets
  $KUBECTL delete configmaps --all -n "$ns" --timeout=30s 2>/dev/null || true
  $KUBECTL delete secrets --all -n "$ns" --timeout=30s 2>/dev/null || true

  # RBAC
  $KUBECTL delete serviceaccounts --all -n "$ns" --timeout=30s 2>/dev/null || true
  $KUBECTL delete roles --all -n "$ns" --timeout=30s 2>/dev/null || true
  $KUBECTL delete rolebindings --all -n "$ns" --timeout=30s 2>/dev/null || true

  # Storage
  $KUBECTL delete pvc --all -n "$ns" --timeout=60s 2>/dev/null || true

  # Security / availability
  $KUBECTL delete networkpolicies --all -n "$ns" --timeout=30s 2>/dev/null || true
  $KUBECTL delete poddisruptionbudgets --all -n "$ns" --timeout=30s 2>/dev/null || true
  $KUBECTL delete resourcequotas --all -n "$ns" --timeout=30s 2>/dev/null || true

  # OpenShift-specific
  if ! $K8S_MODE; then
    $KUBECTL delete routes --all -n "$ns" --timeout=30s 2>/dev/null || true
  fi

  log_success "Resources deleted from $ns"

  # Delete the namespace
  log_info "Deleting namespace $ns..."
  if $KUBECTL delete namespace "$ns" --timeout=60s 2>/dev/null; then
    log_success "Namespace $ns deleted"
  else
    log_warn "Namespace deletion timed out — removing finalizers..."
    $KUBECTL get namespace "$ns" -o json | \
      jq '.spec.finalizers = []' | \
      $KUBECTL replace --raw "/api/v1/namespaces/$ns/finalize" -f - 2>/dev/null || true
    # Wait briefly for it to disappear
    sleep 3
    if $KUBECTL get namespace "$ns" &>/dev/null; then
      log_error "Namespace $ns still exists. May need manual cleanup."
    else
      log_success "Namespace $ns deleted (finalizers stripped)"
    fi
  fi
  echo ""
}

# A2A cleanup: remove cluster-scoped resources (OpenShift only)
# Note: the AuthBridge auto-registers a Keycloak client using the SPIFFE ID.
# That client becomes orphaned when the namespace is deleted, but it's harmless.
A2A_ENABLED="${A2A_ENABLED:-false}"
if [ "$A2A_ENABLED" = "true" ] && ! $K8S_MODE; then
  log_info "Removing A2A SCC ClusterRoleBinding..."
  $KUBECTL delete clusterrolebinding "openclaw-authbridge-scc-${OPENCLAW_NAMESPACE}" 2>/dev/null && \
    log_success "ClusterRoleBinding openclaw-authbridge-scc-${OPENCLAW_NAMESPACE} deleted" || \
    log_warn "ClusterRoleBinding not found (already removed)"
  echo ""
fi

# Remove cluster-scoped resources (OpenShift only, non-A2A)
if ! $K8S_MODE; then
  log_info "Removing OpenClaw OAuthClient..."
  $KUBECTL delete oauthclient "$OPENCLAW_NAMESPACE" 2>/dev/null && \
    log_success "OAuthClient $OPENCLAW_NAMESPACE deleted" || \
    log_warn "OAuthClient $OPENCLAW_NAMESPACE not found (already removed)"
  echo ""
fi

# Remove cluster-viewer RBAC (applies to both OpenShift and K8s)
log_info "Removing cluster-viewer ClusterRoleBinding..."
$KUBECTL delete clusterrolebinding "openclaw-cluster-viewer-${OPENCLAW_NAMESPACE}" 2>/dev/null && \
  log_success "ClusterRoleBinding openclaw-cluster-viewer-${OPENCLAW_NAMESPACE} deleted" || \
  log_warn "ClusterRoleBinding not found (already removed)"
echo ""

teardown_namespace "$OPENCLAW_NAMESPACE"

# Optionally delete .env
if $DELETE_ENV && [ -f "$ENV_FILE" ]; then
  rm "$ENV_FILE"
  log_success "Deleted $ENV_FILE"
  echo ""
elif [ -f "$ENV_FILE" ]; then
  log_info "$ENV_FILE kept (use --delete-env to remove)"
  echo ""
fi

# Clean up generated/ directory
if [ -d "$REPO_ROOT/generated" ]; then
  log_info "Cleaning up generated/ directory..."
  rm -rf "$REPO_ROOT/generated"
  log_success "Removed generated/ directory"
else
  log_info "No generated/ directory to clean up"
fi
echo ""

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Teardown Complete                                         ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "To redeploy, run: ./scripts/setup.sh$(if $K8S_MODE; then echo ' --k8s'; fi)"
echo ""
