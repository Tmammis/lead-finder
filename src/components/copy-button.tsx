"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { toast } from "sonner";
import { copyToClipboardSafe } from "@/lib/utils/clipboard";

// Small icon button that copies `value` to the clipboard and briefly shows a
// check mark. Used inline beside copyable fields (email, phone, etc.).
export function CopyButton({
  value,
  label = "value",
  className = "",
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyToClipboardSafe(value);
    if (ok) {
      setCopied(true);
      toast.success(`Copied ${label}`);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toast.error("Could not copy");
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? "Copied!" : `Copy ${label}`}
      aria-label={`Copy ${label}`}
      className={`rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors shrink-0 ${className}`}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}
