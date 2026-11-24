import { describe, expect, it } from "vitest";
import { extractLocalPreviewUrls } from "../index.js";

describe("Track 5 [B12.3] Script local preview URL extraction & safety contracts", () => {
  it("extracts and normalizes localhost/loopback preview URLs while stripping ANSI colors", () => {
    const noisyLog = [
      "\u001b[32m  ➜  Local:   http://localhost:5173/\u001b[0m",
      "\u001b[36m  ➜  Network: http://0.0.0.0:4173/app.\u001b[0m",
      "Listening on http://127.0.0.1:8080/api?ready=1,",
      "IPv6: http://[::]:3000/dashboard and http://[::1]:9000",
      "Duplicate: http://localhost:5173/",
    ].join("\n");

    expect(extractLocalPreviewUrls(noisyLog)).toEqual([
      "http://localhost:5173/",
      "http://127.0.0.1:4173/app",
      "http://127.0.0.1:8080/api?ready=1",
      "http://localhost:3000/dashboard",
      "http://[::1]:9000/",
    ]);
  });

  it("rejects non-loopback domains, invalid ports, non-http protocols, and enforces 6-item cap", () => {
    const unsafeLog = [
      "https://evil.example.com:8443/steal",
      "http://192.168.1.25:3000/",
      "http://localhost:99999/badport",
      "http://localhost:0/zero",
      "ws://localhost:8080/ws",
      "http://localhost:3001",
      "http://localhost:3002",
      "http://localhost:3003",
      "http://localhost:3004",
      "http://localhost:3005",
      "http://localhost:3006",
      "http://localhost:3007",
    ].join("\n");

    const extracted = extractLocalPreviewUrls(unsafeLog);
    expect(extracted).toHaveLength(6);
    expect(extracted).toEqual([
      "http://localhost:3001/",
      "http://localhost:3002/",
      "http://localhost:3003/",
      "http://localhost:3004/",
      "http://localhost:3005/",
      "http://localhost:3006/",
    ]);
  });
});
