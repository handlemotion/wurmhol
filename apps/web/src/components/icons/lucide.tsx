// The app's glyphs: Lucide (ISC licence), round and outlined, drawn at stroke 1.5 so they read as
// thin as the type beside them. Each export keeps the name its call sites use; size and colour
// come from the caller's classes, as before.
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  Ellipsis,
  Info,
  KeyRound,
  LogOut,
  Mail,
  TriangleAlert,
  Users,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

function thin(Icon: LucideIcon, name: string) {
  const Thin = (props: LucideProps) => <Icon aria-hidden strokeWidth={1.5} {...props} />;
  Thin.displayName = name;
  return Thin;
}

export const IconCheck = thin(Check, "IconCheck");
export const IconChevronDown = thin(ChevronDown, "IconChevronDown");
export const IconChevronRight = thin(ChevronRight, "IconChevronRight");
export const IconChevronsUpDown = thin(ChevronsUpDown, "IconChevronsUpDown");
export const IconCircleAlert = thin(CircleAlert, "IconCircleAlert");
export const IconCircleCheck = thin(CircleCheck, "IconCircleCheck");
export const IconCircleX = thin(CircleX, "IconCircleX");
export const IconCopy = thin(Copy, "IconCopy");
export const IconEllipsis = thin(Ellipsis, "IconEllipsis");
export const IconInfo = thin(Info, "IconInfo");
export const IconKey = thin(KeyRound, "IconKey");
export const IconLogOut = thin(LogOut, "IconLogOut");
export const IconMail = thin(Mail, "IconMail");
export const IconTriangleAlert = thin(TriangleAlert, "IconTriangleAlert");
export const IconUsers = thin(Users, "IconUsers");
