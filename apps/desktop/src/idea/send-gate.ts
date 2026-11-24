/**
 * Whether a draft is an Idea Tree command that should open the parameters card
 * first (#1277).
 *
 * Deferring is a UI step, not an interception: the card seeds the command back
 * into the composer as a token and never sends anything itself, so the send that
 * finally leaves is the reader's own — and it arrives with a task, because the
 * composer refuses an empty one. There is no "already confirmed" pass to
 * distinguish: nothing reaches this gate twice.
 */
import { isIdeaTreeCommand } from "./command.js";

export function defersIdeaSend(text: string): boolean {
  return isIdeaTreeCommand(text);
}