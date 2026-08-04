/**
 * Pinned codebase-memory-mcp v0.9.0 release assets.
 * SHA-256 is of the archive (from upstream checksums.txt), not the extracted binary.
 */

export const CBM_VERSION = "v0.9.0";

const RELEASE_BASE =
  "https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.9.0";

export type CbmTarget = {
  /** Key: `${process.platform}-${process.arch}` */
  archiveName: string;
  archiveSha256: string;
  binaryName: string;
  archiveUrl: string;
};

const TARGETS: Record<string, CbmTarget> = {
  "darwin-arm64": {
    archiveName: "codebase-memory-mcp-darwin-arm64.tar.gz",
    archiveSha256:
      "faa02f0404230c451a9812230394481948f80183801fa5bf67044b41c2f25ed4",
    binaryName: "codebase-memory-mcp",
    archiveUrl: `${RELEASE_BASE}/codebase-memory-mcp-darwin-arm64.tar.gz`,
  },
  "darwin-x64": {
    archiveName: "codebase-memory-mcp-darwin-amd64.tar.gz",
    archiveSha256:
      "6af3d02a27f589901fa763d3971089337bc8c9838bbed5d0cf543ca9f1a9e543",
    binaryName: "codebase-memory-mcp",
    archiveUrl: `${RELEASE_BASE}/codebase-memory-mcp-darwin-amd64.tar.gz`,
  },
  "linux-x64": {
    archiveName: "codebase-memory-mcp-linux-amd64-portable.tar.gz",
    archiveSha256:
      "8459d5c9d1457f2c82de3de307ffc7641ecbba2dde893427be1e62eca8ef9b25",
    binaryName: "codebase-memory-mcp",
    archiveUrl: `${RELEASE_BASE}/codebase-memory-mcp-linux-amd64-portable.tar.gz`,
  },
  "linux-arm64": {
    archiveName: "codebase-memory-mcp-linux-arm64-portable.tar.gz",
    archiveSha256:
      "b0a43fdaf534073c16707d72726b73b149d4c1212034b281ee8b7b2dac755107",
    binaryName: "codebase-memory-mcp",
    archiveUrl: `${RELEASE_BASE}/codebase-memory-mcp-linux-arm64-portable.tar.gz`,
  },
  "win32-x64": {
    archiveName: "codebase-memory-mcp-windows-amd64.zip",
    archiveSha256:
      "92f96896f952e539f0d6cb34d7892a25064b677ccbf808b8f8310ad897e86f2c",
    binaryName: "codebase-memory-mcp.exe",
    archiveUrl: `${RELEASE_BASE}/codebase-memory-mcp-windows-amd64.zip`,
  },
};

export function targetKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function resolveTarget(): CbmTarget | null {
  return TARGETS[targetKey()] ?? null;
}

export function isPlatformSupported(): boolean {
  return resolveTarget() !== null;
}

export { TARGETS };
