// The gallery's sample content, from the Penpot file and ux-writing.md. Three unrelated flows
// appear across the samples, so no component reads as if one story were the product
// (design-system.md, "Sample data proves the genericity").
import type { SelectOption } from "../components/atoms/Select";

export const FLOWS = {
  recordings: "Recordings to Anytype",
  invoices: "Invoices from the mailbox",
  photos: "Photos from the camera card",
} as const;

export const TYPES: readonly SelectOption[] = [
  { value: "meeting-notes", label: "Meeting notes" },
  { value: "customer-brief", label: "Customer brief" },
  { value: "invoice", label: "Invoice" },
];

export const SPACES: readonly SelectOption[] = [
  { value: "renaissance", label: "Renaissance" },
  { value: "renewal-notes", label: "Renewal notes" },
  { value: "rent", label: "Rent" },
  { value: "accounting", label: "Accounting" },
];
