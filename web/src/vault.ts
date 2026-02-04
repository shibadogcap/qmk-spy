// Poti48 WebHID Vault - File packing/unpacking

export type VaultFile =
  | { name: string; type: "text"; content: string }
  | { name: string; type: "binary"; content: Uint8Array };

const MAGIC = 0x50545648; // "PTVH"
const VERSION = 0x00000002;
const VERSION_LEGACY = 0x00000001;

const TYPE_TEXT = 0x01;
const TYPE_BINARY = 0x02;

const writeU32 = (view: DataView, offset: number, value: number) => {
  view.setUint32(offset, value, false); // big-endian
};

const readU32 = (view: DataView, offset: number) => view.getUint32(offset, false);

const writeU16 = (view: DataView, offset: number, value: number) => {
  view.setUint16(offset, value, false);
};

const readU16 = (view: DataView, offset: number) => view.getUint16(offset, false);

export const packVault = (files: VaultFile[]): Uint8Array => {
  const encoder = new TextEncoder();
  
  // Calculate total size
  let metadataSize = 12; // magic + version + count
  let dataSize = 0;
  
  const encodedFiles = files.map((file) => {
    const nameBytes = encoder.encode(file.name);
    const contentBytes =
      file.type === "text" ? encoder.encode(file.content) : file.content;
    const typeByte = file.type === "text" ? TYPE_TEXT : TYPE_BINARY;
    metadataSize += 2 + nameBytes.length + 1 + 4; // name_len + name + type + data_len
    dataSize += contentBytes.length;
    return { nameBytes, contentBytes, typeByte };
  });
  
  const totalSize = metadataSize + dataSize;
  const buffer = new Uint8Array(totalSize);
  const view = new DataView(buffer.buffer);
  
  // Write header
  writeU32(view, 0, MAGIC);
  writeU32(view, 4, VERSION);
  writeU32(view, 8, files.length);
  
  // Write metadata
  let offset = 12;
  for (const { nameBytes, contentBytes, typeByte } of encodedFiles) {
    writeU16(view, offset, nameBytes.length);
    offset += 2;
    buffer.set(nameBytes, offset);
    offset += nameBytes.length;
    buffer[offset] = typeByte;
    offset += 1;
    writeU32(view, offset, contentBytes.length);
    offset += 4;
  }
  
  // Write data
  for (const { contentBytes } of encodedFiles) {
    buffer.set(contentBytes, offset);
    offset += contentBytes.length;
  }
  
  return buffer;
};

export const unpackVault = (buffer: Uint8Array): VaultFile[] => {
  if (buffer.length < 12) {
    throw new Error("Invalid vault: too small");
  }
  
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const decoder = new TextDecoder();
  
  const magic = readU32(view, 0);
  if (magic !== MAGIC) {
    throw new Error(`Invalid vault magic: ${magic.toString(16)}`);
  }
  
  const version = readU32(view, 4);
  if (version !== VERSION && version !== VERSION_LEGACY) {
    throw new Error(`Unsupported vault version: ${version}`);
  }
  
  const count = readU32(view, 8);
  if (count > 1000) {
    throw new Error(`Too many files: ${count}`);
  }
  
  // Read metadata
  const metadata: { nameLength: number; name: string; dataLength: number; type: number }[] = [];
  let offset = 12;
  
  for (let i = 0; i < count; i++) {
    if (offset + 2 > buffer.length) {
      throw new Error("Invalid vault: unexpected end in metadata");
    }
    const nameLength = readU16(view, offset);
    offset += 2;
    
    const metaExtra = version === VERSION_LEGACY ? 4 : 5;
    if (offset + nameLength + metaExtra > buffer.length) {
      throw new Error("Invalid vault: unexpected end in metadata");
    }
    const nameBytes = buffer.slice(offset, offset + nameLength);
    const name = decoder.decode(nameBytes);
    offset += nameLength;
    
    let type = TYPE_TEXT;
    if (version !== VERSION_LEGACY) {
      if (offset + 1 > buffer.length) {
        throw new Error("Invalid vault: unexpected end in type");
      }
      type = buffer[offset];
      offset += 1;
    }
    
    const dataLength = readU32(view, offset);
    offset += 4;
    
    metadata.push({ nameLength, name, dataLength, type });
  }
  
  // Read data
  const files: VaultFile[] = [];
  for (const { name, dataLength, type } of metadata) {
    if (offset + dataLength > buffer.length) {
      throw new Error("Invalid vault: unexpected end in data");
    }
    const contentBytes = buffer.slice(offset, offset + dataLength);
    if (version === VERSION_LEGACY || type === TYPE_TEXT) {
      const content = decoder.decode(contentBytes);
      files.push({ name, type: "text", content });
    } else if (type === TYPE_BINARY) {
      files.push({ name, type: "binary", content: contentBytes });
    } else {
      throw new Error(`Invalid vault: unknown file type ${type}`);
    }
    offset += dataLength;
  }
  
  return files;
};
