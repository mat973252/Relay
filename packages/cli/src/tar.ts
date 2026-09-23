/**
 * Minimal ustar tar writer/reader (regular files only) + gzip via node:zlib.
 *
 * Scope: Relay capsules contain only regular files with short relative
 * POSIX names; this implementation validates those constraints instead of
 * implementing the full tar spec. Deterministic output (fixed mtime/mode)
 * so capsule bytes are reproducible for the same logical content.
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";

export interface TarEntry {
  /** Relative POSIX path, <= 99 chars, no "..", no absolute prefix. */
  name: string;
  data: Buffer;
}

const BLOCK = 512;

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function writeString(block: Buffer, offset: number, text: string, length: number): void {
  block.write(text, offset, length, "utf8");
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i += 1) {
    const byte = header[i] ?? 0;
    sum += i >= 148 && i < 156 ? 32 : byte;
  }
  return sum;
}

export function validateEntryName(name: string): void {
  if (name.length === 0) throw new Error(`empty tar entry name`);
  if (name.length > 99) throw new Error(`tar entry name too long (${name.length} > 99): ${name}`);
  if (name.includes("\\")) throw new Error(`tar entry name must use POSIX separators: ${name}`);
  if (name.startsWith("/")) throw new Error(`tar entry name must be relative: ${name}`);
  if (name.split("/").includes("..")) throw new Error(`tar entry name must not traverse up: ${name}`);
}

export function createTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    validateEntryName(entry.name);
    const header = Buffer.alloc(BLOCK);
    writeString(header, 0, entry.name, 100);
    writeString(header, 100, "0000644\0", 8); // mode
    writeString(header, 108, "0000000\0", 8); // uid
    writeString(header, 116, "0000000\0", 8); // gid
    writeString(header, 124, octal(entry.data.byteLength, 12), 12);
    writeString(header, 136, octal(0, 12), 12); // mtime: fixed for determinism
    header.write("        ", 148, 8, "utf8"); // checksum placeholder (spaces)
    header[156] = 0x30; // typeflag '0' regular file
    writeString(header, 257, "ustar\0", 6);
    writeString(header, 263, "00", 2);
    writeString(header, 265, "relay", 32); // uname
    writeString(header, 297, "relay", 32); // gname
    header.write(octal(checksum(header), 8), 148, 8, "utf8");
    chunks.push(header);
    chunks.push(entry.data);
    const padding = (BLOCK - (entry.data.byteLength % BLOCK)) % BLOCK;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // end-of-archive
  return Buffer.concat(chunks);
}

export function extractTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  while (offset + BLOCK <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break; // end-of-archive marker
    const name = header.toString("utf8", 0, 100).replace(/\0.*$/, "");
    const sizeText = header.toString("utf8", 124, 136).replace(/[\0 ]/g, "");
    const size = Number.parseInt(sizeText, 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error(`invalid tar entry size for ${name}: "${sizeText}"`);
    }
    const checksumText = header.toString("utf8", 148, 156).replace(/[\0 ]/g, "");
    const expected = Number.parseInt(checksumText, 8);
    const probe = Buffer.from(header);
    probe.write("        ", 148, 8, "utf8");
    let sum = 0;
    for (const byte of probe) sum += byte;
    if (sum !== expected) throw new Error(`tar header checksum mismatch for ${name}`);
    const typeflag = header[156];
    if (typeflag !== 0x30 && typeflag !== 0x00) {
      throw new Error(`unsupported tar entry type for ${name}: ${String(typeflag)}`);
    }
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > buffer.byteLength) throw new Error(`truncated tar entry: ${name}`);
    validateEntryName(name);
    entries.push({ name, data: Buffer.from(buffer.subarray(dataStart, dataEnd)) });
    offset = dataStart + size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  if (entries.length === 0) throw new Error("tar archive contains no entries");
  return entries;
}

export function gzip(buffer: Buffer): Buffer {
  return gzipSync(buffer, { level: 9 });
}

export function gunzip(buffer: Buffer): Buffer {
  return gunzipSync(buffer);
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
