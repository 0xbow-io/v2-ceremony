import { copy, del, put, type PutBlobResult } from "@vercel/blob";

export function readBlobToken(): string {
  const token = process.env.BLOB_READ_WRITE_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN must be set in the environment.",
    );
  }
  return token;
}

export async function putBinary(
  pathname: string,
  data: Uint8Array,
): Promise<PutBlobResult> {
  const token = readBlobToken();
  return await put(pathname, new Blob([data as BlobPart]), {
    access: "public",
    token,
    contentType: "application/octet-stream",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

// Server-side copy of a blob already in the store to a new pathname. The bytes
// are duplicated inside Blob storage and NEVER stream through this function, so
// promoting a large candidate zkey from the client's pending path to a
// coordinator-owned committed path costs no function memory (unlike downloading
// then putBinary, which buffers the whole file — fatal for the ~137k-constraint
// circuits). Returns the committed url + pathname, same shape as putBinary.
export async function copyBinary(
  fromUrl: string,
  toPathname: string,
): Promise<{ url: string; pathname: string }> {
  const token = readBlobToken();
  const result = await copy(fromUrl, toPathname, {
    access: "public",
    token,
    contentType: "application/octet-stream",
    addRandomSuffix: false,
    allowOverwrite: true,
  });
  return { url: result.url, pathname: result.pathname };
}

export async function deleteBinary(url: string): Promise<void> {
  const token = readBlobToken();
  await del(url, { token });
}
