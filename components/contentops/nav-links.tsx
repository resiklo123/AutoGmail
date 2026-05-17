"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

const ITEMS = [
  { label: "Inbox", href: "/admin/contentops" },
  { label: "Upload", href: "/admin/contentops/upload" },
  { label: "Batches", href: "/admin/contentops/batches" },
  { label: "New post", href: "/admin/contentops/new" },
  { label: "Marketing site", href: "/" },
] as const;

export function ContentOpsNavLinks() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <>
      {pending ? <div className="co-top-progress" /> : null}
      <nav className="co-row" style={{ marginLeft: "auto" }}>
        {ITEMS.map((item) => (
          <button
            key={item.href}
            type="button"
            className="co-nav-btn"
            disabled={pending}
            onClick={() => {
              startTransition(() => {
                router.push(item.href);
              });
            }}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </>
  );
}
