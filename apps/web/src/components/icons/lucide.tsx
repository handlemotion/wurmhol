// The app's glyphs: Lucide (ISC licence), round and outlined, drawn at stroke 1.5 so they read as
// thin as the type beside them. Each export keeps the name its call sites use; size and colour
// come from the caller's classes, as before.
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  Copy,
  CornerDownLeft,
  CreditCard,
  Crown,
  DoorOpen,
  Ellipsis,
  ExternalLink,
  Eye,
  Info,
  KeyRound,
  Laptop,
  LogOut,
  Mail,
  Pencil,
  Settings,
  Plus,
  Sparkles,
  Trash2,
  TriangleAlert,
  UserRound,
  Users,
  X,
  type LucideIcon,
  type LucideProps,
} from "lucide-react";

function thin(Icon: LucideIcon, name: string) {
  const Thin = (props: LucideProps) => <Icon aria-hidden strokeWidth={1.5} {...props} />;
  Thin.displayName = name;
  return Thin;
}

export const IconArrowLeft = thin(ArrowLeft, "IconArrowLeft");
export const IconArrowUpRight = thin(ArrowUpRight, "IconArrowUpRight");
export const IconCheck = thin(Check, "IconCheck");
export const IconChevronDown = thin(ChevronDown, "IconChevronDown");
export const IconChevronRight = thin(ChevronRight, "IconChevronRight");
export const IconChevronsUpDown = thin(ChevronsUpDown, "IconChevronsUpDown");
export const IconCircleAlert = thin(CircleAlert, "IconCircleAlert");
export const IconCircleCheck = thin(CircleCheck, "IconCircleCheck");
export const IconCircleX = thin(CircleX, "IconCircleX");
export const IconCircleStop = thin(CircleStop, "IconCircleStop");
export const IconCopy = thin(Copy, "IconCopy");
export const IconCornerDownLeft = thin(CornerDownLeft, "IconCornerDownLeft");
export const IconCreditCard = thin(CreditCard, "IconCreditCard");
export const IconCrown = thin(Crown, "IconCrown");
export const IconDoorOpen = thin(DoorOpen, "IconDoorOpen");
export const IconEllipsis = thin(Ellipsis, "IconEllipsis");
export const IconExternalLink = thin(ExternalLink, "IconExternalLink");
export const IconEye = thin(Eye, "IconEye");
export const IconInfo = thin(Info, "IconInfo");
export const IconKey = thin(KeyRound, "IconKey");
export const IconLaptop = thin(Laptop, "IconLaptop");
export const IconLogOut = thin(LogOut, "IconLogOut");
export const IconMail = thin(Mail, "IconMail");
export const IconPencil = thin(Pencil, "IconPencil");
export const IconPlus = thin(Plus, "IconPlus");
export const IconSettings = thin(Settings, "IconSettings");
export const IconSparkles = thin(Sparkles, "IconSparkles");
export const IconTrash = thin(Trash2, "IconTrash");
export const IconTriangleAlert = thin(TriangleAlert, "IconTriangleAlert");
export const IconUser = thin(UserRound, "IconUser");
export const IconUsers = thin(Users, "IconUsers");
export const IconX = thin(X, "IconX");
