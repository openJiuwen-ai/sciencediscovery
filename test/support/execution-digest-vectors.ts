// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

// Shared golden bytes, not recomputed by either implementation under test.
// Non-index keys sort by UTF-16 code units; JSON.stringify enumerates integer
// index keys numerically first. Arrays preserve order; object undefined is omitted.
export const executionDigestVectors: Array<{ name: string; value: Record<string, unknown>; canonical: string; digest: string }> = [
  {
    "name": "json-contract-0",
    "value": {
      "workspaceRoot": "/__sciencediscovery_digest_vector_missing__",
      "permissionEpoch": {
        "sessionId": "session"
      },
      "npuDevices": [],
      "executionId": "golden-0",
      "code": "golden fixture only",
      "agentId": "main",
      "nested": {
        "z": 3,
        "a": [
          3,
          {
            "z": false,
            "a": null
          },
          1
        ]
      },
      "stdout": "line\\n quote \" slash \\\\",
      "startedAt": "2026-01-01T00:00:00.000Z",
      "jsonNumbers": [
        0,
        null,
        {
          "value": 0
        }
      ]
    },
    "canonical": "{\"agentId\":\"main\",\"code\":\"golden fixture only\",\"executionId\":\"golden-0\",\"jsonNumbers\":[0,null,{\"value\":0}],\"nested\":{\"a\":[3,{\"a\":null,\"z\":false},1],\"z\":3},\"npuDevices\":[],\"permissionEpoch\":{\"sessionId\":\"session\"},\"startedAt\":\"2026-01-01T00:00:00.000Z\",\"stdout\":\"line\\\\n quote \\\" slash \\\\\\\\\",\"workspaceRoot\":\"/__sciencediscovery_digest_vector_missing__\"}",
    "digest": "sha256:a3a617223c93ea3e9737a010e2ec7a502c91ff9052fe21ab03fa3c0e2b25dfcb"
  },
  {
    "name": "json-contract-1",
    "value": {
      "workspaceRoot": "/__sciencediscovery_digest_vector_missing__",
      "permissionEpoch": {
        "sessionId": "session"
      },
      "npuDevices": [],
      "executionId": "golden-1",
      "code": "golden fixture only",
      "agentId": "main",
      "nested": {
        "é": "accent",
        "z": "ascii",
        "a": {
          "β": "value",
          "Z": true
        }
      },
      "stdout": "界 λ",
      "startedAt": "2026-01-02T00:00:00.000Z"
    },
    "canonical": "{\"agentId\":\"main\",\"code\":\"golden fixture only\",\"executionId\":\"golden-1\",\"nested\":{\"a\":{\"Z\":true,\"β\":\"value\"},\"z\":\"ascii\",\"é\":\"accent\"},\"npuDevices\":[],\"permissionEpoch\":{\"sessionId\":\"session\"},\"startedAt\":\"2026-01-02T00:00:00.000Z\",\"stdout\":\"界 λ\",\"workspaceRoot\":\"/__sciencediscovery_digest_vector_missing__\"}",
    "digest": "sha256:94ed0d546f5939a4ed572e692cd09e8bfbc5d28de11f049e0f38701270a7ca90"
  },
  {
    "name": "json-contract-integer-keys",
    "value": {
      "workspaceRoot": "/__sciencediscovery_digest_vector_missing__",
      "permissionEpoch": {
        "sessionId": "session"
      },
      "npuDevices": [],
      "executionId": "golden-2",
      "code": "golden fixture only",
      "agentId": "main",
      "nested": {
        "10": "ten",
        "2": "two",
        "01": "leading-zero",
        "a": "letter"
      },
      "stdout": "numeric keys",
      "startedAt": "2026-01-03T00:00:00.000Z"
    },
    "canonical": "{\"agentId\":\"main\",\"code\":\"golden fixture only\",\"executionId\":\"golden-2\",\"nested\":{\"2\":\"two\",\"10\":\"ten\",\"01\":\"leading-zero\",\"a\":\"letter\"},\"npuDevices\":[],\"permissionEpoch\":{\"sessionId\":\"session\"},\"startedAt\":\"2026-01-03T00:00:00.000Z\",\"stdout\":\"numeric keys\",\"workspaceRoot\":\"/__sciencediscovery_digest_vector_missing__\"}",
    "digest": "sha256:c62f60fbf3991456ee397d4ac21dd46f1c40eb26469e85eb5b5c85578b5593d0"
  }
];

// The wire omits this property. Both producers must retain that JSON behavior.
for (const vector of executionDigestVectors) vector.value.omitted = undefined;

// JSON renders -0 as 0, array undefined as null, and omits object undefined.
executionDigestVectors[0]!.value.jsonNumbers = [-0, undefined, { omitted: undefined, value: -0 }];
