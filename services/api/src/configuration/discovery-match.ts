// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

/** CFG-R15: match a task word, not an accidental substring of a longer identifier.
 * ASCII letters, digits and underscores stay one word, so "api" does not match
 * "rapid" and "id" does not match "validate" or "session_id". Chinese has no
 * spaces, so "论文" still matches inside "找几篇论文", and "pubmed" still
 * matches inside "启用pubmed". */
export function configurationDiscoveryMatches(query: string, value: string): boolean {
  const normalized = query.toLocaleLowerCase();
  const target = value.toLocaleLowerCase();
  return normalized.split(/\s+/u).some(term => containsBoundedTerm(target, term))
    || target.split(/\s+/u).some(term => containsBoundedTerm(normalized, term));
}

function containsBoundedTerm(haystack: string, term: string): boolean {
  if (term.length <= 1) return false;
  let from = 0;
  while (from < haystack.length) {
    const at = haystack.indexOf(term, from);
    if (at < 0) return false;
    if (!isWordChar(haystack[at - 1]) && !isWordChar(haystack[at + term.length])) return true;
    from = at + 1;
  }
  return false;
}

function isWordChar(value: string | undefined): boolean {
  return value !== undefined && /[a-z0-9_]/u.test(value);
}
