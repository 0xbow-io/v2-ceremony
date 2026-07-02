import { del, put, type PutBlobResult } from "@vercel/blob";

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

export async function deleteBinary(url: string): Promise<void> {
  const token = readBlobToken();
  await del(url, { token });
}
