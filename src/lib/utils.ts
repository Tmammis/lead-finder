import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Apify actors and LLM providers bill in USD. We display costs in Swedish krona
// using a fixed 10x rate (USD * 10), formatted with Swedish comma decimals.
export const USD_TO_SEK = 10;

export function formatKr(usd: number, decimals = 2): string {
  const sek = usd * USD_TO_SEK;
  return `Kr ${sek.toLocaleString("sv-SE", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}
