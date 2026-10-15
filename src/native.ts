export const isBeta = navigator.userAgent.includes('ConperaSwitchBeta/');
export const isNative = isBeta || navigator.userAgent.includes('ConperaSwitchNative/');
export const edition = isNative ? (isBeta ? 'BETA' : '1.0') : 'DEMO';

type NativeReply<T> = { ok: true; data: T } | { ok: false; error: { status: number; code: string; message: string } };
type NativeWindow = Window & { webkit?: { messageHandlers?: { switch?: { postMessage: (request: { action: string; payload: Record<string, unknown> }) => Promise<NativeReply<unknown>> } } } };
export class NativeError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** This bridge never accepts or returns an account token or a full model API key. */
export async function nativeCall<T>(action: 'session' | 'login' | 'cancelLogin' | 'balance' | 'keys' | 'status' | 'apply' | 'restore' | 'logout', payload: Record<string, unknown> = {}): Promise<T> {
  const bridge = (window as NativeWindow).webkit?.messageHandlers?.switch;
  if (!isNative || !bridge) throw new NativeError(503, 'native_unavailable', '请使用 Conpera Switch 桌面客户端。');
  const reply = await bridge.postMessage({ action, payload });
  if (!reply || typeof reply.ok !== 'boolean') throw new NativeError(502, 'invalid_response', '客户端响应无效，请重启后重试。');
  if (!reply.ok) throw new NativeError(reply.error.status, reply.error.code, reply.error.message);
  return reply.data as T;
}
