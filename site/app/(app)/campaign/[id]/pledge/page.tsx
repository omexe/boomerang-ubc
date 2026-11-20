"use client";

import { useParams } from "next/navigation";
import { CampaignScreen } from "@/components/campaign/CampaignScreen";

// the same page with the cursor in the amount field
export default function PledgePage() {
  const { id } = useParams<{ id: string }>();
  const n = /^[1-9][0-9]{0,17}$/.test(id) ? BigInt(id) : 0n;
  return <CampaignScreen id={n} focus />;
}
