import { useState } from 'react';
import { ClipboardIcon, CheckIcon } from 'lucide-react';

interface CopyButtonProps {
  text: string;
  className?: string;
  light?: boolean;
}

export const CopyButton = ({ text, className = '', light = false }: CopyButtonProps) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm ${
        light ? 'text-accent-foreground hover:bg-accent-foreground/10' : 'hover:bg-kinode-orange/10'
      } ${className}`}
    >
      {copied ? (
        <CheckIcon className="h-4 w-4" />
      ) : (
        <ClipboardIcon className="h-4 w-4" />
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
};