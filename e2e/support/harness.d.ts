/** `window.hb`, defined by the echo server's `/harness` page. */
interface HarnessResponse {
  status: number;
  url: string;
  text: string;
  headers: Record<string, string>;
}

interface Window {
  hb: {
    fetch(tag: string, path?: string, init?: RequestInit): Promise<HarnessResponse>;
    post(tag: string, path?: string): Promise<HarnessResponse>;
    put(tag: string, path?: string): Promise<HarnessResponse>;
    xhr(tag: string, path?: string): Promise<{ status: number; text: string }>;
    iframe(tag: string): Promise<true>;
    image(tag: string): Promise<true>;
  };
  activate(key: string): Promise<{ ok: boolean; reason?: string; plan?: string }>;
}
