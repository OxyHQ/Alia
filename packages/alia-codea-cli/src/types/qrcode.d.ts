/**
 * Only `create` is declared because only `create` is used: the CLI draws the
 * symbol itself (see `utils/approval-surface.ts`). `qrcode` is CommonJS, so the
 * default import is the whole `module.exports`.
 */
declare module 'qrcode' {
  export interface QRCodeCreateOptions {
    errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  }
  export interface QRCodeSymbol {
    readonly version: number;
    readonly modules: {
      readonly size: number;
      /** Truthy when the module at (row, col) is dark. */
      get(row: number, col: number): number | boolean;
    };
  }
  const QRCode: {
    create(text: string, options?: QRCodeCreateOptions): QRCodeSymbol;
  };
  export default QRCode;
}
