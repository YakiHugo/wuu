import { createContext } from "react";
import type { TurnArtifact } from "./ArtifactOutputs";
import type { ArtifactPreviewMotion } from "./ArtifactPreviewMotion";

export type ArtifactPreviewRequest = {
  threadID: string;
  cwd?: string;
  artifact: TurnArtifact;
  motion?: ArtifactPreviewMotion;
  page?: number;
  pageRequest?: string;
};

export const ArtifactPreviewContext = createContext<((request: ArtifactPreviewRequest) => void) | undefined>(undefined);
export const ArtifactThreadContext = createContext<string | undefined>(undefined);
