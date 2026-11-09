declare namespace chrome {
  const sidebarAction: { toggle(): Promise<void> } | undefined;
  namespace storage {
    interface StorageArea {
      get(keys?: string | string[] | { [key: string]: any } | null): Promise<{ [key: string]: any }>;
    }
  }
}

interface Element {
  [key: string]: any;
}

interface MediaTrackConstraints {
  mandatory?: { [key: string]: any };
}

interface Window {
  desktop: any;
  __transcripablesPrompt: any;
}
