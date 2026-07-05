// Minimal stand-in for the VS Code extension API surface that `authProvider.ts`
// touches. The real `vscode` module only exists inside the extension host, so
// vitest aliases `vscode` to this file (see `vitest.config.ts`). Only the
// members exercised by the auth-provider tests are implemented.

type Listener<T> = (event: T) => void;

export class EventEmitter<T> {
  private listeners: Array<Listener<T>> = [];

  event = (listener: Listener<T>): { dispose: () => void } => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(data: T): void {
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }

  dispose(): void {
    this.listeners = [];
  }
}

export const Disposable = {
  from: (...disposables: Array<{ dispose: () => void }>) => ({
    dispose: () => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
  }),
};

export const authentication = {
  registerAuthenticationProvider: () => ({ dispose: () => undefined }),
};

export const window = {
  registerUriHandler: () => ({ dispose: () => undefined }),
  showInformationMessage: () => undefined,
  showErrorMessage: () => undefined,
};

export const workspace = {
  getConfiguration: () => ({
    get: <T>(_key: string, fallback: T): T => fallback,
  }),
};

export const env = {
  uriScheme: 'vscode',
  asExternalUri: async (uri: { toString(): string }) => uri,
  openExternal: async () => true,
};

export const Uri = {
  parse: (value: string) => ({ toString: () => value }),
};
