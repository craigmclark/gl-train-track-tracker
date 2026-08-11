import { LOCAL_TIMEZONE } from "./config";

const dateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: LOCAL_TIMEZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const timeOnly = new Intl.DateTimeFormat("en-US", {
  timeZone: LOCAL_TIMEZONE,
  hour: "numeric",
  minute: "2-digit",
});

/** Everything user-facing is in Grayslake local time, never UTC or the viewer's zone. */
export function fmtDateTime(d: Date): string {
  return dateTime.format(d);
}

export function fmtTime(d: Date): string {
  return timeOnly.format(d);
}

export function fmtAgo(d: Date): string {
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 min ago";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs === 1 ? "1 hour ago" : `${hrs} hours ago`;
}

export function fmtInterval(seconds: number): string {
  return `${(seconds / 60).toFixed(1)} min`;
}
