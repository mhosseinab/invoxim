export type IconName =
  | "search"
  | "close"
  | "home"
  | "document"
  | "connections"
  | "review"
  | "shield"
  | "lock"
  | "chart";

const paths: Record<IconName, string> = {
  search: "M21 21l-6-6M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z",
  close: "m6 6 12 12M6 18 18 6",
  home: "M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9",
  document: "M6 3h8l4 4v14H6V3Zm8 0v5h4M9 12h6M9 16h6",
  connections:
    "m10 14 4-4M9 16l-2 2a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 0 2-2a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0",
  review: "M9 12l2 2 4-4M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  shield: "m12 3 9 3v6c0 5-9 9-9 9s-9-4-9-9V6l9-3Zm-4 9 3 3 5-6",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5V10Zm7 4v3",
  chart: "M5 20v-6M12 20V9M19 20V4",
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}

export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 48 48" aria-hidden="true">
      <path
        fill="#2451ff"
        d="M8 20h32l6 9v12a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V29l6-9Z"
      />
      <path fill="#eef2ff" d="M13 3h18l7 8v23H10V6a3 3 0 0 1 3-3Z" />
      <path fill="#2451ff" d="M31 3v8h7Z" />
      <path
        stroke="#a8baff"
        strokeWidth="2.8"
        strokeLinecap="round"
        d="M16 14h10m-10 6h16m-16 6h11"
      />
      <path
        d="M7 29h9c3 0 3 6 6 6h5c3 0 3-6 6-6h8"
        fill="none"
        stroke="white"
        strokeWidth="3.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
