import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from 'react-simple-code-editor';
import { highlight, languages } from 'prismjs';
import 'prismjs/components/prism-clike';
import 'prismjs/components/prism-c';
import 'prismjs/components/prism-cpp';
import 'prismjs/components/prism-javascript';
import 'prismjs/components/prism-typescript';
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-markdown';
import 'prismjs/themes/prism-dark.css';

import { 
  Usb, Activity, FileText, FileCode, Trash2, Edit3, Save, 
  Download, Plus, ChevronUp, 
  Languages, Clipboard, X, RefreshCcw, CheckCircle2, AlertCircle
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import { packVault, unpackVault, type VaultFile } from "./vault";
import { translations, type Language, type TKey } from "./translations";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const languageMap: Record<string, string> = {
  js: "javascript", jsx: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", md: "markdown",
  txt: "text", vil: "text"
};

const getLanguageFromFilename = (filename: string | null): string => {
  if (!filename) return "text";
  const ext = filename.split(".").pop()?.toLowerCase();
  return languageMap[ext || ""] || "text";
};

type HidDeviceInfo = { vendorId: number; productId: number; productName?: string; };
type SecretInfo = {
  storageSize: number; flashSize: number; wearSize: number;
  baseAddress: number; maxRead: number; maxWrite: number;
};

type LogEntry = {
  id: number;
  timestamp: Date;
  type: 'info' | 'warn' | 'error' | 'send' | 'recv';
  message: string;
};

const REPORT_SIZE = 32;
const VAULT_MAGIC = 0x50545648;
const CMD_INFO = 0xa0;
const CMD_READ = 0xa1;
const CMD_WRITE = 0xa2;
const CMD_ERASE = 0xa3;

const statusMap: Record<number, string> = {
  0x00: "OK", 0x01: "ERR", 0x02: "BUSY", 0x03: "RANGE", 0x04: "ALIGN", 0x05: "ABORT", 0xff: "UNHANDLED"
};

const toHex = (v: number) => `0x${v.toString(16).padStart(4, "0")}`;
const toHex8 = (v: number) => `0x${v.toString(16).padStart(2, "0")}`;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const writeU32BE = (b: Uint8Array, o: number, v: number) => {
  b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff;
  b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff;
};
const readU32BE = (b: Uint8Array, o: number) =>
  (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
const readU16BE = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];

const getFileBytes = (file: VaultFile): Uint8Array => {
  return file.type === "text" ? textEncoder.encode(file.content) : file.content;
};

const isLikelyText = (bytes: Uint8Array): boolean => {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    let controlCount = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127))) controlCount++;
    }
    return controlCount / Math.max(1, text.length) < 0.01;
  } catch { return false; }
};

const estimateSeconds = (totalBytes: number, chunkSize: number) => {
  if (totalBytes <= 0 || chunkSize <= 0) return 0;
  return Math.max(1, Math.ceil((Math.ceil(totalBytes / chunkSize) * 25) / 1000));
};

export default function App() {
  const [lang, setLang] = useState<Language>(() => {
    const saved = localStorage.getItem('qmk-spy-lang');
    if (saved === 'ja' || saved === 'en') return saved;
    return navigator.language.startsWith('ja') ? 'ja' : 'en';
  });
  const t = translations[lang];

  const [status, setStatus] = useState<TKey>("notConnected");
  const [deviceInfo, setDeviceInfo] = useState<HidDeviceInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [secretInfo, setSecretInfo] = useState<SecretInfo | null>(null);
  const [files, setFiles] = useState<VaultFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [editorText, setEditorText] = useState("");
  const [newFileName, setNewFileName] = useState("");
  const [lastStatus, setLastStatus] = useState("-");
  const [lastLog, setLastLog] = useState("-");
  const [activeReportId, setActiveReportId] = useState(0);
  const [shouldAutoLoad, setShouldAutoLoad] = useState(false);
  const [progress, setProgress] = useState<{
    active: boolean; label: string; done: number; total: number; etaSeconds: number | null;
  }>({ active: false, label: "", done: 0, total: 0, etaSeconds: null });

  const deviceRef = useRef<HIDDevice | null>(null);
  const reportIdRef = useRef<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingRef = useRef<{
    resolve: (data: Uint8Array) => void;
    reject: (error: Error) => void;
    timeoutId: number;
    expectedCmd: number;
  } | null>(null);

  const hasWebHid = useMemo(() => "hid" in navigator, []);

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => {
    localStorage.setItem('qmk-spy-lang', lang);
  }, [lang]);

  const appendLog = (message: string, type: LogEntry['type'] = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    const shortMessage = message.length > 80 ? `${message.slice(0, 80)}…` : message;
    const line = `[${timestamp}] ${type.toUpperCase()}: ${shortMessage}`;
    setLastLog(line);
    console.log(line);
  };

  const handleInputReport = useCallback((event: HIDInputReportEvent) => {
    const pending = pendingRef.current;
    if (!pending) return;

    if (event.reportId !== reportIdRef.current) return;
    const data = new Uint8Array(event.data.buffer);
    if (data.length !== REPORT_SIZE) return;
    if (data[0] !== pending.expectedCmd && data[0] !== 0xff) return;

    window.clearTimeout(pending.timeoutId);
    pendingRef.current = null;
    pending.resolve(data);
  }, []);

  const sendCommand = async (payload: Uint8Array, timeoutMs = 1500) => {
    const hid = deviceRef.current;
    if (!hid || !hid.opened) throw new Error(t.notConnected);
    if (pendingRef.current) throw new Error(t.error.busy);

    const buffer = new Uint8Array(REPORT_SIZE);
    buffer.set(payload.slice(0, REPORT_SIZE));

    setBusy(true);
    try {
      const response = new Promise<Uint8Array>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          pendingRef.current = null;
          reject(new Error(t.error.timeout));
        }, timeoutMs);
        pendingRef.current = { resolve, reject, timeoutId, expectedCmd: buffer[0] };
      });

      appendLog(Array.from(buffer).map(toHex8).join(" "), 'send');
      await hid.sendReport(reportIdRef.current, buffer);
      const data = await response;
      setLastStatus(`${statusMap[data[1]] || "UNK"} (${toHex8(data[1])})`);
      appendLog(Array.from(data).map(toHex8).join(" "), 'recv');
      return data;
    } finally { setBusy(false); }
  };

  const connect = async () => {
    if (!hasWebHid) { setStatus("unsupported"); return; }
    setBusy(true);
    try {
      setStatus("connecting");
      
      // Try to reuse previously granted device first
      const grantedDevices = await navigator.hid.getDevices();
      let device = grantedDevices.find(d => 
        d.collections.some(c => c.usagePage === 0xff60 && c.usage === 0x61)
      );
      
      // If no granted device found, request new permission
      if (!device) {
        const devices = await navigator.hid.requestDevice({
          filters: [{ usagePage: 0xff60, usage: 0x61 }]
        });
        device = devices[0];
      }
      
      if (!device) { setStatus("notConnected"); return; }

      if (!device.opened) await device.open();
      device.addEventListener("inputreport", handleInputReport as EventListener);
      deviceRef.current = device;

      const rawCollection = device.collections.find(
        c => c.usagePage === 0xff60 && c.usage === 0x61
      );
      const rawOutputId = rawCollection?.outputReports?.[0]?.reportId as number | undefined;
      reportIdRef.current = rawOutputId ?? 0;
      setActiveReportId(reportIdRef.current);

      setDeviceInfo({ vendorId: device.vendorId, productId: device.productId, productName: device.productName });
      setStatus("connected");
      appendLog(`Connected: ${device.productName || "Unknown"}`);
      setShouldAutoLoad(true);
    } catch (error) {
      appendLog(`Error: ${String(error)}`, 'error');
      setStatus("notConnected");
    } finally { setBusy(false); }
  };

  const disconnect = async () => {
    if (!deviceRef.current) return;
    setBusy(true);
    try {
      const current = deviceRef.current;
      current.removeEventListener("inputreport", handleInputReport as EventListener);
      if (current.opened) await current.close();
      deviceRef.current = null;
      reportIdRef.current = 0;
      setActiveReportId(0);
      setDeviceInfo(null); setSecretInfo(null); setLastStatus("-");
      setFiles([]); setSelectedFile(null); setEditorText("");
      setProgress({ active: false, label: "", done: 0, total: 0, etaSeconds: null });
      setStatus("notConnected");
      appendLog("Disconnected");
    } catch (error) { appendLog(`Disconnect Error: ${String(error)}`, 'error'); }
    finally { setBusy(false); }
  };

  const fetchInfo = async () => {
    try {
      const resp = await sendCommand(Uint8Array.from([CMD_INFO]));
      if (resp[1] !== 0x00) return;
      setSecretInfo({
        storageSize: readU32BE(resp, 2), flashSize: readU32BE(resp, 6),
        wearSize: readU32BE(resp, 10), baseAddress: readU32BE(resp, 14),
        maxRead: resp[18], maxWrite: resp[19]
      });
    } catch (error) { appendLog(`INFO fail: ${String(error)}`, 'error'); }
  };

  const handleRead = async () => {
    const offset = 0;
    const maxRead = secretInfo?.maxRead ?? 28;
    const maxSize = secretInfo?.storageSize ?? 1048576;
    
    setProgress({ active: true, label: "READ", done: 0, total: 0, etaSeconds: null });
    try {
      let readTotal = 0; let readStart = performance.now();
      const readRange = async (start: number, length: number) => {
        const out = new Uint8Array(length);
        let rem = length; let cur = start; let pos = 0;
        while (rem > 0) {
          const sz = Math.min(maxRead, rem);
          const p = new Uint8Array(REPORT_SIZE);
          p[0] = CMD_READ; writeU32BE(p, 1, cur); p[5] = sz;
          const resp = await sendCommand(p);
          if (resp[1] !== 0x00) throw new Error("READ Fail");
          const act = resp[2]; if (act === 0) break;
          out.set(resp.slice(3, 3 + act), pos);
          pos += act; rem -= act; cur += act;
          setProgress(prev => {
            const done = prev.done + act;
            if (readTotal > 0) {
              const elap = (performance.now() - readStart) / 1000;
              const rate = elap > 0 ? done / elap : 0;
              return { ...prev, done, etaSeconds: rate > 0 ? Math.ceil((readTotal - done) / rate) : null };
            }
            return { ...prev, done };
          });
          if (act < sz) break;
        }
        return out.slice(0, pos);
      };

      const concat = (a: Uint8Array, b: Uint8Array) => {
        const m = new Uint8Array(a.length + b.length);
        m.set(a, 0); m.set(b, a.length); return m;
      };

      let buffer = await readRange(offset, 12);
      if (buffer.length < 12) {
        setFiles([]); setProgress({ active: false, label: "READ", done: 0, total: 0, etaSeconds: null });
        return;
      }

      const magic = readU32BE(buffer, 0);
      if (magic !== VAULT_MAGIC) {
        // 空のストレージ（消去済み）かチェック
        const isEmpty = buffer.every(b => b === 0xff || b === 0x00);
        if (isEmpty) {
          setFiles([]);
          setProgress({ active: false, label: "READ", done: 12, total: 12, etaSeconds: 0 });
          return;
        }
        
        // 有効なデータがある場合のみ読み込み続ける
        let cur = offset + buffer.length;
        const chunks = Array.from(buffer);
        while (cur < offset + maxSize) {
          const c = await readRange(cur, Math.min(maxRead, offset + maxSize - cur));
          if (c.length === 0) break;
          chunks.push(...Array.from(c)); cur += c.length;
          if (c.length < maxRead) break;
        }
        const raw = new Uint8Array(chunks);
        const text = textDecoder.decode(raw);
        setFiles([{ name: "raw.txt", type: "text", content: text }]);
        setSelectedFile("raw.txt"); setEditorText(text);
        setProgress({ active: false, label: "READ", done: raw.length, total: raw.length, etaSeconds: 0 });
        return;
      }

      const version = readU32BE(buffer, 4);
      const count = readU32BE(buffer, 8);
      let curs = 12; let dTot = 0;
      for (let i = 0; i < count; i++) {
        while (buffer.length < curs + 2) buffer = concat(buffer, await readRange(offset + buffer.length, maxRead));
        const nLen = readU16BE(buffer, curs);
        const meta = version === 1 ? 4 : 5;
        while (buffer.length < curs + 2 + nLen + meta) buffer = concat(buffer, await readRange(offset + buffer.length, maxRead));
        curs += 2 + nLen + (version === 1 ? 0 : 1);
        dTot += readU32BE(buffer, curs); curs += 4;
      }

      const tSz = Math.min(maxSize, curs + dTot);
      readTotal = tSz; readStart = performance.now();
      setProgress(p => ({ ...p, total: tSz, etaSeconds: estimateSeconds(tSz, maxRead) }));

      if (buffer.length < tSz) buffer = concat(buffer, await readRange(offset + buffer.length, tSz - buffer.length));

      const vFiles = unpackVault(buffer);
      setFiles(vFiles);
      if (vFiles.length > 0) {
        setSelectedFile(vFiles[0].name);
        setEditorText(vFiles[0].type === "text" ? vFiles[0].content : "");
      }
      setProgress({ active: false, label: "READ", done: buffer.length, total: buffer.length, etaSeconds: 0 });
    } catch (e) {
      appendLog(`READ fail: ${String(e)}`, 'error');
      setProgress({ active: false, label: "READ", done: 0, total: 0, etaSeconds: null });
    }
  };

  const handleWrite = async () => {
    const offset = 0;
    const buffer = packVault(files);
    if (buffer.length === 0) return;
    if (secretInfo && (offset + buffer.length > secretInfo.storageSize)) {
      appendLog(`Size limit exceeded`, 'error'); return;
    }
    const mw = secretInfo?.maxWrite ?? 26;
    const est = estimateSeconds(buffer.length, mw);
    if (!window.confirm(t.confirmWrite)) return;
    
    setProgress({ active: true, label: "WRITE", done: 0, total: buffer.length, etaSeconds: est });
    const SS = 4096;
    const sS = Math.floor(offset / SS) * SS;
    const eS = Math.ceil((offset + buffer.length) / SS) * SS;
    try {
      const ep = new Uint8Array(REPORT_SIZE);
      ep[0] = CMD_ERASE; writeU32BE(ep, 1, sS); writeU32BE(ep, 5, eS - sS);
      const er = await sendCommand(ep, 5000);
      if (er[1] !== 0x00) throw new Error("Erase fail");

      const start = performance.now();
      let rem = buffer.length; let cur = offset; let bPos = 0;
      while (rem > 0) {
        const sz = Math.min(rem, mw);
        const p = new Uint8Array(REPORT_SIZE);
        p[0] = CMD_WRITE; writeU32BE(p, 1, cur); p[5] = sz;
        p.set(buffer.slice(bPos, bPos + sz), 6);
        const resp = await sendCommand(p);
        if (resp[1] !== 0x00) throw new Error("Write Fail");
        cur += sz; bPos += sz; rem -= sz;
        const done = buffer.length - rem;
        const elap = (performance.now() - start) / 1000;
        const rate = elap > 0 ? done / elap : 0;
        setProgress({ active: true, label: "WRITE", done, total: buffer.length, etaSeconds: rate > 0 ? Math.ceil((buffer.length - done) / rate) : null });
      }
      setProgress({ active: false, label: "WRITE", done: buffer.length, total: buffer.length, etaSeconds: 0 });
      await disconnect();
    } catch (e) {
      appendLog(`WRITE fail: ${String(e)}`, 'error');
      setProgress({ active: false, label: "WRITE", done: 0, total: 0, etaSeconds: null });
    }
  };

  const handleEraseAll = async () => {
    if (!secretInfo) return;
    if (!window.confirm(t.confirmErase)) return;
    
    setBusy(true);
    setProgress({ active: true, label: "ERASE", done: 0, total: secretInfo.storageSize, etaSeconds: 5 });
    try {
      const ep = new Uint8Array(REPORT_SIZE);
      ep[0] = CMD_ERASE;
      writeU32BE(ep, 1, 0);
      writeU32BE(ep, 5, secretInfo.storageSize);
      const er = await sendCommand(ep, 10000);
      if (er[1] !== 0x00) throw new Error("Erase fail");
      
      setFiles([]);
      setSelectedFile(null);
      setEditorText("");
      setProgress({ active: false, label: "ERASE", done: secretInfo.storageSize, total: secretInfo.storageSize, etaSeconds: 0 });
      appendLog("Storage erased successfully");
    } catch (e) {
      appendLog(`ERASE fail: ${String(e)}`, 'error');
      setProgress({ active: false, label: "ERASE", done: 0, total: 0, etaSeconds: null });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (shouldAutoLoad && deviceInfo) {
      setShouldAutoLoad(false);
      (async () => { await fetchInfo(); await handleRead(); })();
    }
  }, [shouldAutoLoad, deviceInfo]);

  const isConnected = !!deviceInfo;
  const selObj = useMemo(() => files.find(f => f.name === selectedFile), [files, selectedFile]);

  return (
    <div className="min-h-screen p-4 md:p-8 bg-[var(--app-bg)]">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* Header */}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <div className="rounded-xl bg-indigo-500 p-2 text-white shadow-lg shadow-indigo-500/20 shrink-0">
              <Usb size={24} />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight truncate">{t.title}</h1>
              <p className="text-xs text-[var(--muted-text)] font-medium">QMK-SPY WEBHID STORAGE</p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              className={cn(
                "flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-bold transition-all",
                isConnected 
                ? "bg-rose-500 text-white shadow-lg shadow-rose-500/20" 
                : "bg-indigo-500 text-white shadow-lg shadow-indigo-500/20 hover:scale-[1.02] active:scale-[0.98]"
              )}
              onClick={isConnected ? disconnect : connect}
              disabled={busy}
            >
              {isConnected ? <X size={16} /> : <Usb size={16} />}
              {isConnected ? t.disconnect : t.connect}
            </button>
          </div>
        </header>

        {/* Connection Info */}
        <section className="app-card overflow-hidden">
          <div className="flex flex-col gap-4 p-5 md:flex-row md:items-center">
            <div className="flex-1 space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <div className={cn("h-2 w-2 rounded-full", isConnected ? "bg-emerald-500 animate-pulse" : "bg-slate-400")} />
                <span>{t[status] || status}</span>
              </div>
              {deviceInfo && (
                <p className="text-xs text-[var(--muted-text)] font-mono">
                  {deviceInfo.productName} ({toHex(deviceInfo.vendorId)}:{toHex(deviceInfo.productId)})
                </p>
              )}
            </div>
            {secretInfo && (
              <div className="flex flex-wrap gap-4 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-[var(--muted-text)]">{t.infoSize}:</span>
                  <span className="font-mono font-bold">{secretInfo.storageSize.toLocaleString()} B</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[var(--muted-text)]">Used:</span>
                  <span className="font-mono font-bold">{packVault(files).length.toLocaleString()} B</span>
                  <span className="text-[var(--muted-text)]">({Math.round((packVault(files).length / secretInfo.storageSize) * 100)}%)</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[var(--muted-text)]">Max R/W:</span>
                  <span className="font-mono font-bold">{secretInfo.maxRead}/{secretInfo.maxWrite}</span>
                </div>
              </div>
            )}
          </div>
          {progress.active && (
            <div className="border-t border-[var(--card-border)] bg-slate-50/50 dark:bg-slate-900/50">
              <div className="px-5 py-2 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Activity size={14} className="text-indigo-500 animate-pulse" />
                  <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400">
                    {progress.label}ING... {Math.round((progress.done / (progress.total || 1)) * 100)}%
                  </span>
                  <span className="text-[10px] font-mono text-[var(--muted-text)]">
                    {progress.etaSeconds !== null ? `${progress.etaSeconds}s remaining` : 'Calculating...'}
                  </span>
                </div>
              </div>
              <div className="h-1 w-full bg-slate-200 dark:bg-slate-800">
                <div 
                  className="h-full bg-indigo-500 transition-all duration-300" 
                  style={{ width: `${(progress.done / (progress.total || 1)) * 100}%` }} 
                />
              </div>
            </div>
          )}
        </section>

        <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
          {/* File Sidebar */}
          <aside className="space-y-6">
            <div className="app-card flex flex-col">
              <div className="border-b border-[var(--card-border)] p-4 flex items-center justify-between">
                <h2 className="text-sm font-bold flex items-center gap-2">
                  <FileText size={16} />
                  FileList ({files.length})
                </h2>
                <div className="flex gap-1">
                   <button 
                    onClick={() => fileInputRef.current?.click()} 
                    className="p-1 hover:bg-slate-100 dark:hover:bg-slate-800 rounded transition-colors"
                    title={t.upload}
                    disabled={!isConnected}
                  >
                    <Plus size={16} />
                  </button>
                  <button
                    className="p-1 hover:bg-rose-100 dark:hover:bg-rose-900/20 rounded transition-colors text-rose-500"
                    onClick={handleEraseAll}
                    disabled={!isConnected || busy}
                    title={t.eraseAll}
                  >
                    <Trash2 size={16} />
                  </button>
                  <input ref={fileInputRef} type="file" className="hidden" onChange={async (e) => {
                    const f = e.target.files?.[0]; if (!f) return;
                    if (files.some(existing => existing.name === f.name)) return;
                    const buf = new Uint8Array(await f.arrayBuffer());
                    const isTxt = isLikelyText(buf);
                    const newF: VaultFile = isTxt ? { name: f.name, type: "text", content: textDecoder.decode(buf) } : { name: f.name, type: "binary", content: buf };
                    setFiles(prev => [...prev, newF]); setSelectedFile(f.name); e.target.value = "";
                  }} />
                </div>
              </div>
              <div className="h-[380px] overflow-y-auto p-2 space-y-1">
                {files.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-[var(--muted-text)] opacity-50 space-y-2">
                    <AlertCircle size={32} strokeWidth={1.5} />
                    <p className="text-xs font-medium">{t.noFiles}</p>
                  </div>
                ) : (
                  files.map((f, idx) => (
                    <div
                      key={f.name}
                      onClick={() => { setSelectedFile(f.name); if (f.type === 'text') setEditorText(f.content); }}
                      className={cn(
                        "group flex items-center gap-2 rounded-lg px-3 py-2 text-sm cursor-pointer transition-all",
                        selectedFile === f.name 
                        ? "bg-indigo-500 text-white shadow-md shadow-indigo-500/20" 
                        : "hover:bg-slate-100 dark:hover:bg-slate-800"
                      )}
                    >
                      {f.type === 'text' ? <FileText size={14} className="shrink-0" /> : <FileCode size={14} className="shrink-0" />}
                      <span className="flex-1 truncate font-medium">{f.name}</span>
                      <div className={cn("flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity", selectedFile === f.name && "opacity-100")}>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            if (idx === 0) return;
                            const nf = [...files]; [nf[idx-1], nf[idx]] = [nf[idx], nf[idx-1]]; setFiles(nf);
                          }}
                          className="hover:text-amber-400"
                        ><ChevronUp size={12} /></button>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setFiles(prev => prev.filter(x => x.name !== f.name));
                            if (selectedFile === f.name) setSelectedFile(null);
                          }}
                          className="hover:text-rose-400"
                        ><Trash2 size={12} /></button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="p-3 border-t border-[var(--card-border)]">
                 <div className="flex gap-2">
                  <input
                    className="min-w-0 flex-1 rounded bg-[var(--app-bg)] border border-[var(--card-border)] px-2 py-1.5 text-xs outline-none focus:border-indigo-500 transition-colors"
                    placeholder={t.fileName}
                    value={newFileName}
                    onChange={e => setNewFileName(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newFileName.trim()) {
                        setFiles(p => [...p, { name: newFileName.trim(), type: 'text', content: '' }]);
                        setSelectedFile(newFileName.trim()); setEditorText(''); setNewFileName('');
                      }
                    }}
                  />
                  <button
                    disabled={!newFileName.trim()}
                    onClick={() => {
                      setFiles(p => [...p, { name: newFileName.trim(), type: 'text', content: '' }]);
                      setSelectedFile(newFileName.trim()); setEditorText(''); setNewFileName('');
                    }}
                    className="p-1.5 bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:opacity-50"
                  >
                    <Plus size={16} />
                  </button>
                </div>
              </div>
            </div>
          </aside>

          {/* Main Content */}
          <main className="space-y-6 min-w-0">
            <div className="app-card flex flex-col overflow-hidden">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-[var(--card-border)] px-5 py-3 gap-3 bg-slate-50/50 dark:bg-slate-900/50">
                <div className="flex items-center gap-3">
                  <h2 className="font-bold flex items-center gap-2">
                    <Edit3 size={18} className="text-indigo-500" />
                    Editor
                  </h2>
                  {selObj && (
                    <span className="rounded-full bg-indigo-100 dark:bg-indigo-900/40 px-3 py-0.5 text-[10px] font-bold text-indigo-600 dark:text-indigo-300 uppercase tracking-tight">
                      {selObj.type}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex gap-1.5">
                    <button
                      className="flex items-center gap-1.5 rounded-lg border border-[var(--card-border)] bg-[var(--card-bg)] px-3 py-1.5 text-xs font-bold hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors disabled:opacity-40"
                      onClick={handleRead} disabled={!isConnected || busy}
                    >
                      <RefreshCcw size={14} className={cn(busy && "animate-spin")} />
                      {t.read}
                    </button>
                    <button
                      className="flex items-center gap-1.5 rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-600 transition-colors disabled:opacity-40"
                      onClick={handleWrite} disabled={!isConnected || busy || files.length === 0}
                    >
                      <Save size={14} />
                      {t.write}
                    </button>
                  </div>
                  <div className="w-px h-4 bg-[var(--card-border)] mx-1" />
                  <div className="flex gap-1">
                    <button
                      className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
                      onClick={() => selObj && (async () => {
                        const b = getFileBytes(selObj);
                        const blob = new Blob([b as unknown as BlobPart], { type: selObj.type === "text" ? "text/plain" : "application/octet-stream" });
                        const url = URL.createObjectURL(blob); const a = document.createElement("a");
                        a.href = url; a.download = selObj.name; a.click(); URL.revokeObjectURL(url);
                      })()}
                      disabled={!selObj}
                      title={t.download}
                    >
                      <Download size={16} />
                    </button>
                    <button
                      className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
                      onClick={() => selObj && selObj.type === 'text' && navigator.clipboard.writeText(selObj.content)}
                      disabled={!selObj || selObj.type !== 'text'}
                      title={t.copyText}
                    >
                      <Clipboard size={16} />
                    </button>
                  </div>
                </div>
              </div>

              <div className="h-[500px] flex">
                {!selObj ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-[var(--muted-text)] opacity-40 space-y-4 py-32">
                    <FileText size={64} strokeWidth={1} />
                    <p className="font-bold underline underline-offset-4 decoration-slate-300">{t.selectFile}</p>
                  </div>
                ) : selObj.type === 'binary' ? (
                  <div className="flex-1 flex flex-col items-center justify-center text-[var(--muted-text)] p-8 text-center space-y-4">
                    <div className="rounded-full bg-slate-100 dark:bg-slate-800 p-6">
                      <FileCode size={48} />
                    </div>
                    <div className="space-y-1">
                      <p className="font-bold text-[var(--app-text)]">{t.binaryBlocked}</p>
                      <p className="text-sm">{t.binaryNotSupported}</p>
                      <p className="text-xs font-mono bg-slate-100 dark:bg-slate-800 px-2 py-1 rounded inline-block mt-2">
                        {t.sizeLabel}: {getFileBytes(selObj).length.toLocaleString()} bytes
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="flex-1 flex overflow-hidden">
                     <div className="bg-slate-50 dark:bg-slate-900 border-r border-[var(--card-border)] py-4 px-2 text-right select-none min-w-[3rem] overflow-y-auto">
                      {editorText.split('\n').map((_, i) => (
                        <div key={i} className="text-[10px] font-mono text-[var(--muted-text)] leading-6 h-6">
                          {i + 1}
                        </div>
                      ))}
                    </div>
                    <div className="flex-1 relative overflow-y-auto bg-white dark:bg-[#1e1e1e]">
                      <Editor
                        value={editorText}
                        onValueChange={code => {
                          setEditorText(code);
                          setFiles(prev => prev.map(f => f.name === selObj.name && f.type === 'text' ? { ...f, content: code } : f));
                        }}
                        highlight={code => {
                          const lang = getLanguageFromFilename(selObj.name);
                          const grammar = languages[lang] || languages.text;
                          return highlight(code, grammar, lang);
                        }}
                        padding={16}
                        className="font-mono text-sm leading-6 outline-none text-slate-900 dark:text-slate-100"
                        style={{ fontFamily: 'Fira Code, monospace' }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </main>
        </div>
        
        <footer className="flex flex-col sm:flex-row justify-between items-center gap-4 text-[10px] font-bold text-[var(--muted-text)] uppercase tracking-widest pb-8">
           <div className="flex items-center gap-4">
             <div className="flex items-center gap-2">
               <div className="h-1 w-1 bg-[var(--muted-text)] rounded-full" />
               {t.lastStatus}: <span className="text-emerald-500 font-mono">{lastStatus}</span>
             </div>
             <div className="flex items-center gap-2">
               <div className="h-1 w-1 bg-[var(--muted-text)] rounded-full" />
               {t.reportIdLabel}: <span className="font-mono">{toHex8(activeReportId)}</span>
             </div>
             <div className="flex items-center gap-2">
               <div className="h-1 w-1 bg-[var(--muted-text)] rounded-full" />
               {t.lastLog}: <span className="font-mono normal-case">{lastLog}</span>
             </div>
             <button
               onClick={() => setLang((l: Language) => l === 'ja' ? 'en' : 'ja')}
               className="flex items-center gap-1.5 px-2 py-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
               title={t.switchLanguage}
             >
               <Languages size={12} />
               <span>{lang === 'ja' ? '日本語' : 'English'}</span>
             </button>
           </div>
           <div className="flex items-center gap-4">
              <span>{t.vaultVersion}</span>
              <span>{t.crcEnabled}</span>
              <div className="flex items-center gap-1.5">
                <CheckCircle2 size={12} className="text-emerald-500" />
                <span>{t.productionReady}</span>
              </div>
              <div className="w-px h-3 bg-[var(--muted-text)] opacity-30" />
              <span className="opacity-60">{t.credits}</span>
           </div>
        </footer>
      </div>
    </div>
  );
}
