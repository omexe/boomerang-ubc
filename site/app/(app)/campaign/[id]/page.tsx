"use client";

import { useParams } from "next/navigation";
import { CampaignScreen } from "@/components/campaign/CampaignScreen";

export default function CampaignPage() {
  const { id } = useParams<{ id: string }>();
  const n = /^[1-9][0-9]{0,17}$/.test(id) ? BigInt(id) : 0n;
  return <CampaignScreen id={n} focus={false} />;
}
