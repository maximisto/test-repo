import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ChevronDown from 'lucide-react/dist/esm/icons/chevron-down.js';
import Zap from 'lucide-react/dist/esm/icons/zap.js';
import MessageSquare from 'lucide-react/dist/esm/icons/message-square.js';
import Shield from 'lucide-react/dist/esm/icons/shield.js';
import Cpu from 'lucide-react/dist/esm/icons/cpu.js';
import CreditCard from 'lucide-react/dist/esm/icons/credit-card.js';
import Wrench from 'lucide-react/dist/esm/icons/wrench.js';
import Search from 'lucide-react/dist/esm/icons/search.js';
import X from 'lucide-react/dist/esm/icons/x.js';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import { useTheme } from '../lib/useTheme';

const CATEGORIES = [
  {
    id: 'general',
    label: 'General',
    icon: MessageSquare,
    color: 'text-violet-400',
    bg: 'bg-violet-500/10',
    border: 'border-violet-500/20',
    faqs: [
      {
        q: 'What exactly is VIOLEMA?',
        a: 'VIOLEMA is an AI operator for recurring founder and team workflows. Unlike a chatbot that waits for prompts, VIOLEMA is built to carry work across multiple steps, coordinate with connected tools, and report back with what it did.',
      },
      {
        q: 'How is VIOLEMA different from ChatGPT or Claude.ai?',
        a: 'Consumer AI tools are conversational interfaces. VIOLEMA is a work execution layer. It connects to your actual systems, remembers workflow context, runs multi-step work, and operates in configurable autonomy modes so you stay in control. Each run shows the steps taken, tools used, outputs produced, approval state, and delivery history.',
      },
      {
        q: 'How is VIOLEMA different from task bots or coding agents?',
        a: 'Task bots usually live in one surface, and coding agents focus mostly on software engineering. VIOLEMA is designed around recurring operating workflows: revenue checks, founder updates, research briefs, customer follow-up, and technical handoffs with approvals and delivery logs.',
      },
      {
        q: 'Who is VIOLEMA built for?',
        a: 'VIOLEMA is designed for founders, operators, and small teams with repeated operational work that needs follow-through, not just advice.',
      },
    ],
  },
  {
    id: 'capabilities',
    label: 'Capabilities',
    icon: Cpu,
    color: 'text-cyan-400',
    bg: 'bg-cyan-500/10',
    border: 'border-cyan-500/20',
    faqs: [
      {
        q: 'What can VIOLEMA actually do?',
        a: 'Today VIOLEMA can search the web for research, write and execute code, send Slack or email messages, capture browser screenshots, schedule recurring automations, and route work across the workspace. The product is designed to expand into more operational systems over time.',
      },
      {
        q: 'What are autonomy modes?',
        a: 'VIOLEMA has three modes: Autonomous for pre-approved routine work, Cautious for explain-then-act workflows, and Supervised for step-by-step execution traces with approval before moving forward.',
      },
      {
        q: 'What does "execution transparency" mean?',
        a: 'Each run shows what steps were taken, which tools and sources were used, what output was produced, whether approval is needed, and what happened after delivery. The goal is a useful operating trace, not a mystery box.',
      },
      {
        q: 'Can VIOLEMA run scheduled tasks automatically?',
        a: 'Yes. You can tell VIOLEMA to run any task on a recurring schedule — "send the weekly eng standup digest every Monday at 9am", "check CAC from PostHog every Friday", etc. Automations run in the background and surface results in your dashboard.',
      },
      {
        q: 'Does VIOLEMA have memory?',
        a: 'VIOLEMA keeps conversation history and saved thread context today. Broader shared workspace memory is part of the direction, but it is not yet a full always-on company memory system.',
      },
    ],
  },
  {
    id: 'security',
    label: 'Security & Privacy',
    icon: Shield,
    color: 'text-green-400',
    bg: 'bg-green-500/10',
    border: 'border-green-500/20',
    faqs: [
      {
        q: 'Is my data safe with VIOLEMA?',
        a: 'We take security seriously. Data is encrypted in transit, sensitive actions are gated by workspace controls, and we do not use your conversation data to train AI models. If you need specific compliance commitments, talk to us before rolling VIOLEMA into a regulated environment.',
      },
      {
        q: 'Who builds the AI that powers VIOLEMA?',
        a: 'VIOLEMA uses a routed model stack rather than a single model. Claude Sonnet 5 handles most interactive work, Claude Opus 5 covers harder reasoning and critical high-stakes tasks, GPT-4.1 mini and Claude Haiku handle lightweight and operational lanes, and Mistral handles embeddings and memory. That keeps the system both capable and efficient.',
      },
      {
        q: 'Can I connect VIOLEMA to my internal tools without exposing credentials?',
        a: 'For supported integrations, credentials are handled through the integration layer and scoped to the workspace. If you need custom internal tools or stronger controls, that should be treated as an enterprise setup rather than assumed out of the box.',
      },
      {
        q: 'Do you comply with GDPR, HIPAA, or other regulations?',
        a: 'Treat VIOLEMA as security-conscious software, not as a pre-certified compliance product. If you need GDPR, HIPAA, SOC 2, or contract-specific guarantees, we should scope that explicitly before rollout.',
      },
    ],
  },
  {
    id: 'beta-billing',
    label: 'Beta & Billing',
    icon: CreditCard,
    color: 'text-yellow-400',
    bg: 'bg-yellow-500/10',
    border: 'border-yellow-500/20',
    faqs: [
      {
        q: 'How does beta billing work?',
        a: 'VIOLEMA is in controlled beta. We scope the first workflow with each approved customer before attaching billing, because package limits, support load, and run profitability depend on the work being automated.',
      },
      {
        q: 'What do credits actually represent?',
        a: 'Credits map to real agent work. A heavier run that uses multiple tools, automations, or artifacts consumes more credits than a light chat turn. Approved workspaces can review usage before scaling volume.',
      },
      {
        q: 'Can I cancel any time?',
        a: 'Yes. Any paid beta or workspace agreement can be stopped according to the terms agreed during onboarding. Your workspace data and conversation history remain intact unless you ask us to delete them.',
      },
    ],
  },
  {
    id: 'technical',
    label: 'Technical',
    icon: Wrench,
    color: 'text-purple-400',
    bg: 'bg-purple-500/10',
    border: 'border-purple-500/20',
    faqs: [
      {
        q: 'Does VIOLEMA have an API?',
        a: 'A broader public API and webhook layer are part of the roadmap. Right now the main surface is the web workspace plus connected messaging and automation flows.',
      },
      {
        q: 'Can I build custom tools for VIOLEMA?',
        a: 'Custom connectors are possible, but they are not a polished self-serve workflow yet. Today that should be treated as an implementation project rather than a turnkey button in the product.',
      },
      {
        q: 'What browsers and platforms does VIOLEMA support?',
        a: 'VIOLEMA runs in the browser today and works best on current Chrome, Safari, Edge, and Firefox. The web interface is the primary product surface right now.',
      },
      {
        q: 'Is VIOLEMA open source?',
        a: 'The core platform is proprietary. We open-source our integration SDKs and tool schemas so the community can contribute new connectors. Check github.com/purpleorangeai for our public repos.',
      },
    ],
  },
];

function AccordionItem({ q, a, open, onToggle }: { q: string; a: string; open: boolean; onToggle: () => void }) {
  return (
    <div className={`border rounded-xl overflow-hidden transition-all duration-200 ${open ? 'border-violet-500/40 bg-navy-800/80' : 'border-navy-700/60 bg-navy-800/30 hover:border-navy-600/60'}`}>
      <button
        className="w-full text-left px-6 py-5 flex items-start gap-4 group"
        onClick={onToggle}
        aria-expanded={open}
      >
        <ChevronDown
          className={`w-5 h-5 mt-0.5 flex-shrink-0 text-violet-400 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
        />
        <span className={`font-semibold text-base leading-snug transition-colors ${open ? 'text-white' : 'text-slate-200 group-hover:text-white'}`}>
          {q}
        </span>
      </button>
      <div
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{ maxHeight: open ? '400px' : '0px', opacity: open ? 1 : 0 }}
      >
        <p className="px-6 pb-5 text-slate-400 leading-relaxed text-[15px] pl-[60px]">{a}</p>
      </div>
    </div>
  );
}

export default function FAQ() {
  const navigate = useNavigate();
  const [activeCategory, setActiveCategory] = useState('general');
  const [openItems, setOpenItems] = useState<Record<string, boolean>>({ 'general-0': true });
  const [query, setQuery] = useState('');

  const currentCat = CATEGORIES.find((c) => c.id === activeCategory)!;
  const Icon = currentCat.icon;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleFaqs = currentCat.faqs
    .map((faq, index) => ({ faq, index }))
    .filter(({ faq }) =>
      normalizedQuery.length === 0
        ? true
        : `${faq.q} ${faq.a}`.toLowerCase().includes(normalizedQuery)
    );

  function toggle(key: string) {
    setOpenItems((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  const allOpen = visibleFaqs.length > 0
    && visibleFaqs.every(({ index }) => openItems[`${activeCategory}-${index}`]);

  function toggleAllVisible() {
    setOpenItems((prev) => {
      const next = { ...prev };
      visibleFaqs.forEach(({ index }) => {
        next[`${activeCategory}-${index}`] = !allOpen;
      });
      return next;
    });
  }

  const { scopeClass } = useTheme();
  return (
    <div className={`min-h-screen bg-navy-900 ${scopeClass}`}>
      <Navbar />

      {/* Hero */}
      <section className="pt-32 pb-20 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-violet-900/20 via-transparent to-cyan-900/10 pointer-events-none" />
        <div className="absolute top-20 left-1/2 -translate-x-1/2 w-[600px] h-[200px] bg-violet-600/10 rounded-full blur-3xl pointer-events-none" />
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center relative">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-semibold tracking-wide uppercase mb-6">
            <Zap className="w-3 h-3" fill="currentColor" />
            Frequently Asked Questions
          </div>
          <h1 className="text-5xl sm:text-6xl font-bold text-white mb-6 leading-tight">
            Got questions?<br />
            <span className="bg-gradient-to-r from-violet-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent">
              We've got answers.
            </span>
          </h1>
          <p className="text-xl text-slate-400 max-w-2xl mx-auto">
            Everything you need to know about VIOLEMA — from capabilities and pricing to security and integrations.
          </p>
        </div>
      </section>

      {/* Category tabs + FAQ */}
      <section className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 pb-32">
        {/* Category selector */}
        <div className="flex flex-wrap gap-3 mb-10">
          {CATEGORIES.map((cat) => {
            const CatIcon = cat.icon;
            const active = activeCategory === cat.id;
            return (
              <button
                key={cat.id}
                onClick={() => setActiveCategory(cat.id)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border transition-all duration-200 ${
                  active
                    ? `${cat.bg} ${cat.border} ${cat.color} border-opacity-100`
                    : 'bg-navy-800/40 border-navy-700/60 text-slate-400 hover:text-slate-200 hover:border-navy-600'
                }`}
              >
                <CatIcon className="w-4 h-4" />
                {cat.label}
              </button>
            );
          })}
        </div>

        {/* Active category header */}
        <div className={`flex items-center gap-3 mb-6 p-4 rounded-xl ${currentCat.bg} border ${currentCat.border}`}>
          <div className={`w-9 h-9 rounded-lg ${currentCat.bg} border ${currentCat.border} flex items-center justify-center`}>
            <Icon className={`w-5 h-5 ${currentCat.color}`} />
          </div>
          <div>
            <h2 className="text-white font-semibold">{currentCat.label}</h2>
            <p className="text-slate-500 text-xs">{currentCat.faqs.length} questions</p>
          </div>
        </div>

        <div className="mb-6 space-y-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-500 absolute left-4 top-1/2 -translate-y-1/2" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search in ${currentCat.label.toLowerCase()} questions...`}
              className="w-full bg-navy-800/40 border border-navy-700/60 text-slate-200 placeholder:text-slate-500 rounded-xl py-3 pl-11 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500/40 focus:border-violet-500/40"
            />
            {query && (
              <button
                onClick={() => setQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 p-1 rounded-md"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">
              Showing {visibleFaqs.length} of {currentCat.faqs.length} questions
            </p>
            {visibleFaqs.length > 0 && (
              <button
                onClick={toggleAllVisible}
                className="text-xs text-violet-400 hover:text-violet-300 font-semibold"
              >
                {allOpen ? 'Collapse all' : 'Expand all'}
              </button>
            )}
          </div>
        </div>

        {/* FAQ items */}
        <div className="space-y-3">
          {visibleFaqs.map(({ faq, index }) => (
            <AccordionItem
              key={`${activeCategory}-${index}`}
              q={faq.q}
              a={faq.a}
              open={!!openItems[`${activeCategory}-${index}`]}
              onToggle={() => toggle(`${activeCategory}-${index}`)}
            />
          ))}
          {visibleFaqs.length === 0 && (
            <div className="rounded-xl border border-navy-700/60 bg-navy-800/30 p-6 text-center">
              <p className="text-slate-300 font-medium mb-2">No matches found</p>
              <p className="text-sm text-slate-500">Try a different keyword or switch to another category.</p>
            </div>
          )}
        </div>

        {/* Still have questions CTA */}
        <div className="mt-16 text-center p-10 rounded-2xl bg-gradient-to-br from-violet-900/30 to-navy-800/60 border border-violet-700/30">
          <h3 className="text-2xl font-bold text-white mb-3">Still have questions?</h3>
          <p className="text-slate-400 mb-6 max-w-md mx-auto">
            Apply for the controlled beta, or book a workflow audit when you have a recurring founder workflow ready.
          </p>
          <div className="flex flex-wrap gap-3 justify-center">
            <button
              onClick={() => navigate('/signup?next=%2Fdashboard')}
              className="btn-primary"
            >
              Apply for beta
            </button>
            <a
              href="mailto:hello@violema.com"
              className="btn-secondary"
            >
              Email us
            </a>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}
