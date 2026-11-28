// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Public-URL guard for `web_fetch`.
 *
 * `web_fetch` takes a model-supplied URL, so it is the product's SSRF surface:
 * without this check a page could steer the agent at a link-local metadata
 * endpoint or an internal service. The gateway enforced it before the fetch
 * providers moved into Node; the same rule now runs here, including the DNS
 * resolution step — a public hostname that resolves to a private address must
 * be rejected too, which a syntactic check alone cannot catch.
 */

import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const MAX_URL_LENGTH = 8_192;

export class PublicUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicUrlError";
  }
}

function ipv4Blocked(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a = 0, b = 0] = octets;
  if (a === 0) return true;                                   // unspecified / this-network
  if (a === 10) return true;                                   // private
  if (a === 127) return true;                                  // loopback
  if (a === 169 && b === 254) return true;                     // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;            // private
  if (a === 192 && b === 168) return true;                     // private
  if (a === 100 && b >= 64 && b <= 127) return true;           // carrier-grade NAT
  if (a === 192 && b === 0) return true;                       // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true;         // benchmarking
  if (a >= 224) return true;                                   // multicast + reserved + broadcast
  return false;
}

function normalizeIpv6(address: string): string {
  return address.toLowerCase().replace(/^\[|\]$/g, "");
}

/** Expand an IPv6 literal to eight hextets; undefined when it is not a plain IPv6 address. */
function ipv6Hextets(value: string): number[] | undefined {
  const text = value.split("%")[0] ?? "";                      // drop a zone id, e.g. fe80::1%eth0
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const hextets: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      hextets.push(Number.parseInt(group, 16));
    }
    return hextets;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

/**
 * Rewrite a trailing dotted quad as two hextets. The dotted and hex spellings are the same address,
 * and each family below reads its embedded IPv4 from its own position, so the rewrite has to happen
 * before that decoding rather than being judged as the tail.
 */
function dottedTailToHextets(value: string): string {
  const match = value.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return value;
  const octets = match.slice(2, 6).map(Number);
  if (octets.some((octet) => octet > 255)) return value;
  const high = (octets[0]! << 8) | octets[1]!;
  const low = (octets[2]! << 8) | octets[3]!;
  return `${match[1]}${high.toString(16)}:${low.toString(16)}`;
}

function ipv6Blocked(address: string): boolean {
  const value = normalizeIpv6(address);
  if (value === "::" || value === "::1") return true;          // unspecified / loopback
  if (value.startsWith("fe8") || value.startsWith("fe9")
    || value.startsWith("fea") || value.startsWith("feb")) return true; // link-local
  if (value.startsWith("fec") || value.startsWith("fed")
    || value.startsWith("fee") || value.startsWith("fef")) return true; // deprecated site-local fec0::/10
  if (value.startsWith("fc") || value.startsWith("fd")) return true;    // unique-local
  if (value.startsWith("ff")) return true;                     // multicast
  // A trailing dotted quad spells the same 32 bits as two hextets. Rewrite it in hex first so a
  // dotted spelling and its hex spelling get the same verdict from the family decoding below,
  // instead of the dotted value being matched at the tail regardless of the family's position.
  const hextets = ipv6Hextets(dottedTailToHextets(value));
  if (!hextets) return false;
  const mapped = hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff;
  const compatible = hextets.slice(0, 6).every((hextet) => hextet === 0);
  const high = hextets[6]!; const low = hextets[7]!;
  const embeddedIpv4 = (highHextet: number, lowHextet: number): string =>
    `${highHextet >> 8}.${highHextet & 0xff}.${lowHextet >> 8}.${lowHextet & 0xff}`;
  if (mapped || compatible) return ipv4Blocked(embeddedIpv4(high, low));
  // The remaining transitional forms also carry an IPv4 address, in a position the mapped and
  // compatible tests above do not cover. Each is decoded and handed to the same ipv4Blocked table,
  // so a public embedded address stays public and the whole prefix is never banned as a class.
  if (hextets[0] === 0x0064 && hextets[1] === 0xff9b && hextets[2]! <= 1
    && hextets[3] === 0 && hextets[4] === 0 && hextets[5] === 0) {
    return ipv4Blocked(embeddedIpv4(high, low));                // NAT64 64:ff9b::/96, 64:ff9b:1::/96
  }
  if (hextets[0] === 0x2002) return ipv4Blocked(embeddedIpv4(hextets[1]!, hextets[2]!)); // 6to4 2002::/16
  if (hextets[0] === 0x2001 && hextets[1] === 0) {
    // Teredo 2001:0::/32 obfuscates the client IPv4 by inverting its bits.
    return ipv4Blocked(embeddedIpv4(~high & 0xffff, ~low & 0xffff));
  }
  if (hextets.slice(0, 4).every((hextet) => hextet === 0) && hextets[4] === 0xffff && hextets[5] === 0) {
    return ipv4Blocked(embeddedIpv4(high, low));                // IPv4-translated ::ffff:0:0:0/96
  }
  return false;
}

/** True when the literal address is not routable public space. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return ipv4Blocked(address);
  if (family === 6) return ipv6Blocked(address);
  return false;
}

/**
 * Validate a model-supplied fetch target. Rejects non-http(s), embedded
 * credentials, and any host that resolves to non-public address space.
 */
export async function assertPublicUrl(
  rawUrl: string,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolve,
): Promise<string> {
  if (typeof rawUrl !== "string" || rawUrl.length > MAX_URL_LENGTH) {
    throw new PublicUrlError(`url must be a string no longer than ${MAX_URL_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new PublicUrlError("url must be a public http(s) URL without embedded credentials");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new PublicUrlError("url must be a public http(s) URL without embedded credentials");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname.toLowerCase() === "localhost") {
    throw new PublicUrlError("local and private network URLs are not allowed");
  }
  const addresses = isIP(hostname) ? [hostname] : await resolveHost(hostname);
  if (!addresses.length) {
    throw new PublicUrlError("host could not be resolved");
  }
  if (addresses.some(isBlockedAddress)) {
    throw new PublicUrlError("local and private network URLs are not allowed");
  }
  return rawUrl;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  try {
    const records = await lookup(hostname, { all: true });
    return records.map((record) => record.address);
  } catch {
    // An unresolvable host cannot be proven public, so it is refused rather
    // than handed to the provider.
    return [];
  }
}
