import Link from "next/link";
import Image from "next/image";
import SceneMount from "@/components/home/SceneMount";
import ScrollDriver from "@/components/home/ScrollDriver";
import CampaignHud from "@/components/home/CampaignHud";
import { CountUp, LineReveal } from "@/components/home/Reveal";
import { demoCampaign } from "@/lib/story";

const usd = (n: number) => n.toLocaleString("en-US");

function Section({
  i,
  children,
  id,
  wide,
  hero,
}: {
  i: number;
  children: React.ReactNode;
  id?: string;
  wide?: boolean;
  hero?: boolean;
}) {
  return (
    <section
      id={id}
      data-story={i}
      className={`relative flex items-center px-6 md:px-[7vw] ${hero ? "min-h-screen pb-[14vh]" : "min-h-[110vh]"}`}
    >
      <div className={`w-full ${wide ? "max-w-[680px]" : "max-w-[520px]"}`}>{children}</div>
    </section>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="font-serif text-[44px] leading-[1.04] tracking-[-0.01em] text-paper md:text-[56px]">
      {children}
    </h2>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-6 text-[17px] leading-[1.6] text-paper">{children}</p>;
}

function Source({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 font-mono text-[11px] tracking-wide text-mist">{children}</p>;
}

function Cta({
  href,
  children,
  primary,
}: {
  href: string;
  children: React.ReactNode;
  primary?: boolean;
}) {
  return (
    <Link
      href={href}
      className={
        primary
          ? "inline-flex h-12 items-center gap-3 rounded-[5px] bg-paper px-6 text-[15px] font-medium text-ink transition-colors hover:bg-glow"
          : "inline-flex h-12 items-center gap-3 rounded-[5px] border border-paper px-6 text-[15px] font-medium text-paper transition-colors hover:border-glow hover:text-glow"
      }
    >
      {children}
      <span aria-hidden>→</span>
    </Link>
  );
}

export default function Home() {
  return (
    <main className="relative">
      <SceneMount />
      <ScrollDriver />
      <CampaignHud />

      {/* header */}
      <header className="fixed inset-x-0 top-0 z-30 flex items-center justify-between px-6 py-5 md:px-[7vw]">
        <Link href="/" className="flex items-center gap-3">
          <Image src="/logo-mark.png" alt="" width={34} height={34} priority />
          <span className="font-serif text-[22px] leading-none text-paper">Boomerang</span>
        </Link>
        <nav className="flex items-center gap-8 text-[14px] text-paper">
          <a href="#how" className="hidden hover:text-glow md:inline">How it works</a>
          <a href="#why" className="hidden hover:text-glow md:inline">Why now</a>
          <Link href="/login" className="rounded-[5px] border border-line px-4 py-2 hover:border-paper">
            Log in
          </Link>
        </nav>
      </header>

      <div className="relative z-10">
        {/* 0 · hero */}
        <Section i={0} wide hero>
          <LineReveal
            lines={["Crowdfunding", "that pays you", "to back first."]}
            className="font-serif text-[64px] leading-[0.98] tracking-[-0.015em] text-paper md:text-[84px]"
          />
          <p className="mt-6 max-w-[500px] text-[17px] leading-[1.6] text-paper">
            Back a community campaign early. If it reaches its goal, your money pays for the
            thing. If it falls short, you get your money back plus a bonus.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Cta href="/login?role=backer" primary>
              Back a campaign
            </Cta>
            <Cta href="/login?role=sponsor">Sponsor a campaign</Cta>
          </div>
        </Section>

        {/* 1 · problem */}
        <Section i={1} id="how">
          <H2>Nobody wants to go first.</H2>
          <P>
            A crowdfund only works once it gets moving. Until then, everyone waits to see if
            anyone else will pledge, so good campaigns stall before they start.
          </P>
          <div className="mt-10 border-l border-line pl-5">
            <p className="font-serif text-[40px] leading-none text-paper">
              <CountUp to={90} suffix="%" />
            </p>
            <p className="mt-3 text-[15px] leading-[1.55] text-paper">
              of early Kickstarter projects that reached 30% of their goal went on to get
              funded. The first 30% is the hard part.
            </p>
            <Source>Kickstarter, two-year stats, 2011</Source>
          </div>
        </Section>

        {/* 2 · sponsor */}
        <Section i={2}>
          <H2>A DAO puts money down first.</H2>
          <P>
            Before anyone pledges, the sponsor locks two amounts in a contract that nobody can
            change.
          </P>
          <dl className="mt-8 divide-y divide-line border-y border-line">
            <div className="flex items-baseline justify-between gap-6 py-4">
              <dt className="font-serif text-[24px] text-paper">The match</dt>
              <dd className="text-right text-[15px] text-paper">Goes to the cause if the goal is met.</dd>
            </div>
            <div className="flex items-baseline justify-between gap-6 py-4">
              <dt className="font-serif text-[24px] text-paper">The bonus</dt>
              <dd className="text-right text-[15px] text-paper">Goes to early backers if the goal is missed.</dd>
            </div>
          </dl>
          <Source>
            In this example, {demoCampaign.sponsor} locks a ${usd(demoCampaign.match)} match and a $
            {usd(demoCampaign.bonus)} bonus for a ${usd(demoCampaign.goal)} goal.
          </Source>
        </Section>

        {/* 3 · early */}
        <Section i={3}>
          <H2>Pledge early and you win either way.</H2>
          <P>
            Pledge before the cutoff and you earn a share of the bonus. If the campaign succeeds,
            you get the thing you funded. If it fails, you get your money back plus your share.
          </P>
          <P>
            The sponsor decides whether every early pledge earns the same share or earlier
            pledges earn more. The contract records your share the moment your pledge lands.
          </P>
        </Section>

        {/* 4 · late */}
        <Section i={4}>
          <H2>Late pledges still count.</H2>
          <P>
            After the cutoff, your pledge still moves the campaign toward its goal. It earns no
            bonus, and if the campaign falls short, you get a full refund.
          </P>
        </Section>

        {/* 5 · met */}
        <Section i={5}>
          <H2>The cause gets every pledge plus the match.</H2>
          <P>
            The recipient gets paid and builds the thing. Backers get what they funded, and the
            bonus flies back to the sponsor.
          </P>
        </Section>

        {/* 6 · missed */}
        <Section i={6}>
          <H2>Everyone gets their money back. Early backers get more.</H2>
          <P>
            The contract refunds every pledge and splits the bonus among early backers. The
            sponsor gets the match back, along with any bonus left over.
          </P>
        </Section>

        {/* 7 · why now */}
        <Section i={7} id="why">
          <H2>Money already moves onchain.</H2>
          <P>
            Stablecoins hold about $289 billion today, more than double what they held at the
            start of 2024. Communities already pay each other onchain, so they should raise money
            there too. Boomerang runs on Arc, where every pledge settles in USDC, even when a
            backer pays from another chain.
          </P>
          <div className="mt-10 grid grid-cols-3 gap-6 border-t border-line pt-6">
            <div>
              <p className="font-serif text-[34px] leading-none text-paper">
                <CountUp to={289} prefix="$" suffix="B" />
              </p>
              <p className="mt-2 text-[13px] leading-[1.45] text-paper">in stablecoins today</p>
              <Source>DefiLlama, Nov 2026</Source>
            </div>
            <div>
              <p className="font-serif text-[34px] leading-none text-paper">
                <CountUp to={90} suffix="%" />
              </p>
              <p className="mt-2 text-[13px] leading-[1.45] text-paper">of projects past 30% get funded</p>
              <Source>Kickstarter, 2011</Source>
            </div>
            <div>
              <p className="font-serif text-[34px] leading-none text-paper">1998</p>
              <p className="mt-2 text-[13px] leading-[1.45] text-paper">when economists first proposed refund bonuses</p>
              <Source>Tabarrok, 1998</Source>
            </div>
          </div>
          <p className="mt-8 text-[15px] leading-[1.6] text-paper">
            In lab tests, bonuses for early backers led to more funded campaigns. Boomerang puts
            that idea onchain.
          </p>
          <Source>Cason, Tabarrok &amp; Zubrickas, Games and Economic Behavior, 2021</Source>
        </Section>

        {/* 8 · cta */}
        <Section i={8}>
          <H2>Back one, or start one.</H2>
          <div className="mt-10 grid gap-4">
            <Link
              href="/login?role=backer"
              className="group block rounded-[6px] border border-line bg-charcoal/70 p-6 backdrop-blur-sm transition-colors hover:border-paper"
            >
              <p className="font-serif text-[28px] leading-tight text-paper">I want to back campaigns</p>
              <p className="mt-2 text-[15px] leading-[1.55] text-paper">
                Find campaigns your community cares about, pledge early, and earn a bonus if one
                falls short.
              </p>
              <p className="mt-5 text-[15px] font-medium text-paper group-hover:text-glow">Back a campaign →</p>
            </Link>
            <Link
              href="/login?role=sponsor"
              className="group block rounded-[6px] border border-line bg-charcoal/70 p-6 backdrop-blur-sm transition-colors hover:border-paper"
            >
              <p className="font-serif text-[28px] leading-tight text-paper">I run a DAO treasury</p>
              <p className="mt-2 text-[15px] leading-[1.55] text-paper">
                Put up a match and a bonus, set a goal, and give your community a reason to move
                first.
              </p>
              <p className="mt-5 text-[15px] font-medium text-paper group-hover:text-glow">Sponsor a campaign →</p>
            </Link>
          </div>
        </Section>
      </div>
    </main>
  );
}
