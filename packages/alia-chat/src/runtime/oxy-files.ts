import { useOxy } from '@oxy.so/services/ui/client';
import { useMemo } from 'react';
import type { AliaAttachment } from '../types';
import type { UploadDocument } from './attachment-utils';

/** The slice of `OxyServices` an upload needs: Oxy Files' own `assets.upload` (`POST /assets/upload`). */
export interface OxyFilesClient {
  assets: {
    upload(
      file: { uri: string; type?: string; name?: string; size?: number },
      options?: { visibility?: 'private' | 'public' | 'unlisted' },
    ): Promise<{ file: { id: string } }>;
  };
}

/** Put `attachment` in the person's Oxy Files, private, and answer its id. */
export function uploadToOxyFiles(oxy: OxyFilesClient): UploadDocument {
  return async (attachment: AliaAttachment) => {
    const { file } = await oxy.assets.upload(
      {
        uri: attachment.uri,
        type: attachment.mimeType,
        name: attachment.name,
        size: attachment.size,
      },
      { visibility: 'private' },
    );
    if (typeof file?.id !== 'string' || file.id === '') throw new Error('Oxy Files gave no id');
    return file.id;
  };
}

/** The signed-in person's document upload, for a turn's `file` parts. */
export function useDocumentUpload(): UploadDocument {
  const { oxyServices } = useOxy();
  return useMemo(() => uploadToOxyFiles(oxyServices as unknown as OxyFilesClient), [oxyServices]);
}
