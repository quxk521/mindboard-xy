export type NodeKind = "text" | "image" | "link";
export type Side = "top" | "right" | "bottom" | "left";
export type Tool = "select" | "text" | "image" | "link";

export interface ViewState {
  x: number;
  y: number;
  scale: number;
}

export interface CropState {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface BoardNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  color: string;
  textColor?: string;
  scrollY?: number;
  asset?: string;
  assetUrl?: string;
  crop?: CropState;
  url?: string;
}

export interface BoardEdge {
  id: string;
  fromNode: string;
  fromSide: Side;
  toNode: string;
  toSide: Side;
  color: string;
  label: string;
  arrow: "none" | "forward" | "both";
}

export interface BoardGroup {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  color: string;
}

export type JumpSlot = "nw" | "n" | "ne" | "w" | "c" | "e" | "sw" | "s" | "se";

export interface JumpArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface BoardState {
  version: number;
  view: ViewState;
  nodes: BoardNode[];
  edges: BoardEdge[];
  groups: BoardGroup[];
  jumpAreas?: Partial<Record<JumpSlot, JumpArea>>;
}

export interface ImportedImage {
  asset: string;
  assetUrl: string;
  width: number;
  height: number;
}

export interface MindboardBridge {
  loadBoard(): Promise<BoardState>;
  saveBoard(board: BoardState): Promise<{ ok: boolean }>;
  pickImages(): Promise<ImportedImage[]>;
  importFilePaths(paths: string[]): Promise<ImportedImage[]>;
  readClipboardImage(): Promise<ImportedImage | null>;
  readClipboardText(): Promise<string>;
  exportBoard(board: BoardState): Promise<{ ok: boolean; path?: string }>;
  importBoard(): Promise<BoardState | null>;
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    mindboard: MindboardBridge;
  }
}
