/**
 * The local service token is the one credential the workspace cannot run
 * without: every `/api` request carries it, so without it even the model
 * catalog is unreadable.
 *
 * A HUAWEI account is no longer a hard gate by itself. The entry page offers
 * two ways in — sign in for credits, or configure a model endpoint — and a
 * workspace opened through either one can add the other later.
 */
export function requiresLocalToken(localToken: string): boolean {
  return localToken.trim() === "";
}
