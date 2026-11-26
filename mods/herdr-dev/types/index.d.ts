// The state contract for herdr-dev. The mod's pane reads these values and the loop writes them.
// Each value is stored by the session under the key below.

export type NoticeKind = "conflict" | "mismatch" | "error" | "info";

export type Notice = {
  key: string;
  kind: NoticeKind;
  text: string;
};

declare module "claude-code" {
  interface PluginState {
    "herdr-dev": {
      notices: Shaped<Notice[]>;
      status: Shaped<string>;
    };
  }
}
