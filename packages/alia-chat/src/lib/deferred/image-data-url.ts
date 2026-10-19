/**
 * The attachment reader, loaded on the first attachment: on native a turn of plain text (and the
 * runtime entry that sends it) never evaluates `expo-file-system`.
 */
export const loadImageDataUrl = () => import('../image-data-url');
