export type SerializedAsset = Record<string, unknown> & { size: string | null };

export function serializeAsset(a: { size?: bigint | null; [k: string]: unknown }): SerializedAsset {
  return {
    ...a,
    size: a.size != null ? a.size.toString() : null,
  };
}

export function serializePostDetail(post: {
  assets: { size?: bigint | null; [k: string]: unknown }[];
  drafts: unknown[];
  logs: unknown[];
  [k: string]: unknown;
}) {
  return {
    ...post,
    assets: post.assets.map(serializeAsset),
    drafts: post.drafts,
    logs: post.logs,
  };
}

export type SerializedIncomingAsset = Record<string, unknown> & { sizeBytes: string | null };

export function serializeIncomingAsset(a: { sizeBytes?: bigint | null; [k: string]: unknown }): SerializedIncomingAsset {
  return {
    ...a,
    sizeBytes: a.sizeBytes != null ? a.sizeBytes.toString() : null,
  };
}

export function serializeUploadBatchDetail(batch: {
  assets: { sizeBytes?: bigint | null; [k: string]: unknown }[];
  [k: string]: unknown;
}) {
  return {
    ...batch,
    assets: batch.assets.map(serializeIncomingAsset),
  };
}
