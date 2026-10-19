import type { ReactNode } from "react";
import { Blobatar } from "blobatar/react";
import {
  WUU_MASCOT_BRAND_COLORS,
  WUU_MASCOT_IDENTITY_PERSPECTIVE,
  WUU_MASCOT_NAME,
  WUU_MASCOT_TRAITS,
} from "./wuu-mascot-spec";
import "./styles/web-workspace-start-page.css";

export function WebWorkspaceStartPage({ searchField }: { searchField: ReactNode }): JSX.Element {
  return (
    <div className="web-workspace-start-page">
      <div className="web-workspace-start-content">
        <Blobatar
          className="web-workspace-start-mascot"
          name={WUU_MASCOT_NAME}
          traits={WUU_MASCOT_TRAITS}
          palette={WUU_MASCOT_BRAND_COLORS}
          perspective={WUU_MASCOT_IDENTITY_PERSPECTIVE}
          background={false}
          alt=""
          draggable={false}
        />
        <div className="web-workspace-start-search">{searchField}</div>
      </div>
    </div>
  );
}
