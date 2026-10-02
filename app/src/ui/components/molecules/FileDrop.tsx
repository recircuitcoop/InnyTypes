// File drop (Penpot 03 Molecules › file-drop). State: Idle, Over, Filled. A dashed hairline
// box, radius m: a file dropped on it is taken; Over turns it accent-soft with an accent line
// while something is dragged over; Filled shows what is chosen in a solid line. The button
// beside the words chooses instead of dropping. Drop handling is Ark UI's FileUpload.
import { FileUpload } from "@ark-ui/react";
import { useState } from "react";
import { Button } from "../atoms/Button";
import { Icon } from "../atoms/Icon";
import { cx, variantAttributes } from "../variant";

export type FileDropState = "idle" | "over" | "filled";

export interface FileDropProps {
  /** Held at a state (the gallery); otherwise Over follows the drag and Filled the message. */
  readonly state?: FileDropState;
  /** Whether something is chosen (Filled), when not held at a state. */
  readonly filled?: boolean;
  /** The sentence in the box, from strings.ts; Over shows overMessage instead. */
  readonly message: string;
  readonly overMessage: string;
  /** The button ("Choose a folder…", "Change folder"); none when absent. */
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  /** The box's accessible name ("Drop a recording"). */
  readonly label: string;
  readonly onFiles?: (files: File[]) => void;
  readonly className?: string;
}

export function FileDrop({
  state,
  filled = false,
  message,
  overMessage,
  actionLabel,
  onAction,
  label,
  onFiles,
  className,
}: FileDropProps) {
  const [dragging, setDragging] = useState(false);
  const shown: FileDropState = state ?? (dragging ? "over" : filled ? "filled" : "idle");
  return (
    <FileUpload.Root
      {...variantAttributes("file-drop", { state: shown })}
      translations={{ dropzone: label }}
      onFileAccept={(details) => {
        setDragging(false);
        onFiles?.(details.files);
      }}
      className={cx("w-full", className)}
    >
      <FileUpload.Dropzone
        disableClick
        onDragEnter={() => {
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        className={cx(
          "flex flex-col items-center justify-center gap-3 rounded-m border p-6 text-center text-body",
          shown === "over" && "border-dashed border-accent bg-accent-soft text-accent",
          shown === "idle" && "border-dashed border-surface-line bg-surface-panel text-primary",
          shown === "filled" && "border-surface-line bg-surface-panel text-primary",
        )}
      >
        <Icon
          name={shown === "filled" ? "folder" : "download"}
          size={20}
          className={shown === "over" ? "text-accent" : "text-secondary"}
        />
        <p>{shown === "over" ? overMessage : message}</p>
        {shown === "over" || actionLabel === undefined ? null : (
          <Button kind="secondary" {...(onAction === undefined ? {} : { onClick: onAction })}>
            {actionLabel}
          </Button>
        )}
      </FileUpload.Dropzone>
      <FileUpload.HiddenInput />
    </FileUpload.Root>
  );
}
