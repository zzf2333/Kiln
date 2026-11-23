import { Dialog } from "radix-ui";
import type { TaskAttachment } from "../api/types";
import { CloseIcon } from "./Icons";

export interface AttachmentLightboxProps {
  attachment: TaskAttachment | null;
  imageUrl: string | null;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function AttachmentLightbox({
  attachment,
  imageUrl,
  onClose,
}: AttachmentLightboxProps) {
  const open = Boolean(attachment && imageUrl);
  if (!open || !attachment || !imageUrl) {
    return null;
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay
          className="palette-mask open"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <Dialog.Content
            className="modal-card modal-card-wide att-lightbox"
            aria-describedby={undefined}
            onEscapeKeyDown={(e) => {
              e.preventDefault();
              onClose();
            }}
          >
            <div className="modal-head">
              <Dialog.Title>{attachment.filename}</Dialog.Title>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭图片预览"
                onClick={onClose}
              >
                <CloseIcon />
              </button>
            </div>
            <div className="modal-body">
              <div className="att-lightbox-frame">
                <img
                  src={imageUrl}
                  alt={attachment.filename}
                  className="att-lightbox-img"
                />
              </div>
              <div className="att-lightbox-meta mono muted">
                <span>{attachment.mime_type}</span>
                <span>{formatBytes(attachment.size_bytes)}</span>
                <span>sha256: {attachment.sha256.slice(0, 12)}</span>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
