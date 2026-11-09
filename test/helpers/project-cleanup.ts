// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0

/** Only an observed HTTP status grants recovery; arbitrary write failures do not. */
function statusOf(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
    ? error.status : undefined;
}

/** Recover deletion of this owned fixture only after an authoritative read.
 * At most two DELETEs; never replay a write when the read is inconclusive. */
export async function deleteOwnedProject(operations: {
  remove: () => Promise<unknown>;
  exists: () => Promise<boolean>;
}): Promise<void> {
  try { await operations.remove(); return; }
  catch (error) {
    if (statusOf(error) === 404) return;
    if (![502, 503, 504].includes(statusOf(error) ?? 0)) throw error;
    let exists: boolean;
    try { exists = await operations.exists(); }
    catch (confirmationError) {
      throw new AggregateError([error, confirmationError], "Project deletion failed and its state could not be confirmed", { cause: error });
    }
    if (!exists) return;
    try { await operations.remove(); }
    catch (retryError) { if (statusOf(retryError) !== 404) throw retryError; }
  }
}
