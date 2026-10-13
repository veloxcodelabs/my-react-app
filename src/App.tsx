// App.tsx
import React, { useState, useEffect } from "react";
import { motion, Variants } from "framer-motion";
import { BrowserRouter as Router, Route, Routes, Link } from "react-router-dom";
import { createClient } from '@supabase/supabase-js';
import Promo from './promo'; // Assuming you have a Promo.js or Promo.tsx

// Initialize Supabase client
const supabase = createClient(
  'https://hdufmrkonhunutzheslt.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhkdWZtcmtvbmh1bnV0emhlc2x0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMDA3NTIsImV4cCI6MjA5MDc3Njc1Mn0.QiBiTJRFeqpz33z24ejz5kcAhQfUY8OP4EREioFS6-8'
);

// Contact Form Page
function ContactForm() {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus('sending');
    const form = e.currentTarget;
    const formData = new FormData(form);
    const name = formData.get('name')?.toString() || '';
    const email = formData.get('email')?.toString() || '';
    const message = formData.get('message')?.toString() || '';

    const { error } = await supabase
      .from('contact_messages')
      .insert([{ name, email, message }]);

    if (error) {
      console.error(error);
      setStatus('error');
    } else {
      setStatus('sent');
      form.reset();
    }
  };

  return (
    <div style={{ maxWidth: 480, margin: '2rem auto', padding: '1rem' }}>
      <h2>Contact</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <input name="name" placeholder="Name" required className="w-full p-2 border rounded" />
        <input name="email" type="email" placeholder="Email" required className="w-full p-2 border rounded" />
        <textarea name="message" placeholder="Message" required className="w-full p-2 border rounded" />
        <button
          type="submit"
          className="bg-green-600 text-white px-4 py-2 rounded"
          disabled={status === 'sending'}
        >
          {status === 'sending' ? 'Sending...' : 'Send Message'}
        </button>
        {status === 'sent' && <p className="text-green-500">Message sent! 🚀</p>}
        {status === 'error' && <p className="text-red-500">Error sending message. Try again.</p>}
      </form>
    </div>
  );
}

// Payment page component
function PaymentPage() {
  return (
    <div style={{ padding: '2rem', textAlign: 'center' }}>
      <h2>Payment Page</h2>
      <p>Make your payment here.</p>
    </div>
  );
}

// AI Solutions Project Page
function AIProjectsPage() {
  return (
    <div>
      <h2>AI Solutions</h2>
      <h1>Empower Your Business with Intelligent Automation</h1>

      <p>🎯 <strong>What we offer:</strong></p>
      <p>
        We build AI agents, automate complex workflows, and integrate smart solutions into your business ecosystem.
        From data verification to process orchestration, we provide scalable, reliable AI systems.
      </p>

      <p>🔑 <strong>Key Benefits:</strong></p>
      <ul>
        <li>Automated workflows: Reduce manual tasks and errors with intelligent agents.</li>
        <li>Data-driven insights: Real-time analysis to make informed decisions.</li>
        <li>Custom integrations: Connect your existing systems with AI solutions seamlessly.</li>
        <li>Enhanced user experience: Automate notifications, onboarding, and client interactions.</li>
      </ul>

      <p>🌟 <strong>Who it's for:</strong></p>
      <ul>
        <li>Businesses looking to streamline operations.</li>
        <li>Startups wanting to deploy AI-powered services quickly.</li>
        <li>Enterprises aiming for digital transformation and efficiency.</li>
      </ul>

      <p>🚀 <strong>Why choose us:</strong></p>
      <p>
        Our AI solutions are practical, robust, and tailored to your business goals. We combine cutting-edge technology with human expertise to deliver measurable results and long-term scalability.
      </p>
    </div>
  );
}

// Main App Component
export default function App() {
  const [showPayment, setShowPayment] = useState(false);

  useEffect(() => {
    const script = document.createElement('script');
    script.src =
      'https://www.paypal.com/sdk/js?client-id=BAAVYiC-srs0QQ7eQzFSPWsDfdJxKxthYO920jVotBhncf-yHaoRwrA_AOdHpsvzPCvCzWsQxa6UzGm5gA&components=hosted-buttons&disable-funding=venmo&currency=EUR';
    script.async = true;
    script.onload = () => {
      if ((window as any).paypal) {
        (window as any).paypal.HostedButtons({ hostedButtonId: 'ZLBZG4YNNYG7Q' })
          .render('#paypal-container');
      }
    };
    document.head.appendChild(script);

    return () => {
      document.head.removeChild(script);
    };
  }, []);

  return (
    <Router>
      <div style={container}>
        <div style={missionSection}>
          <h2>Our Mission</h2>
          <p>
            Our mission is to design intelligent AI solutions that automate workflows, connect systems, and drive business impact.
            We create autonomous agents and scalable architectures that allow companies to save time, reduce errors, and unlock new opportunities.
            Every solution is tailored to the client's unique processes and goals, ensuring measurable results and long-term efficiency.
            We operate with precision, speed, and creativity — transforming complex problems into actionable, AI-powered solutions.
          </p>
        </div>

        {services.map(([emoji, hueA, hueB, service, description], i) => (
          <Card key={i} i={i} emoji={emoji} hueA={hueA} hueB={hueB} service={service} description={description} />
        ))}

        <button onClick={() => setShowPayment(true)} style={showPaymentButtonStyle}>
          Show Payment Page
        </button>
        {showPayment && (
          <div style={paymentPageContainerStyle}>
            <Link to="/payment">Go to Payment Page</Link>
          </div>
        )}

        <Routes>
          <Route path="/payment" element={<PaymentPage />} />
          <Route path="/ai-projects" element={<AIProjectsPage />} />
          <Route path="/contact" element={<ContactForm />} />
          <Route path="/Promo" element={<Promo />} />
        </Routes>

        <div id="paypal-container" style={{ display: 'none' }} />

        <div style={{ textAlign: 'center', marginTop: 120 }}>
          <Link to="/contact" style={{ margin: '0 1rem' }}>Contact</Link>
          <a href="https://obssettings.martitony.com" style={{ margin: '0 1rem' }}>Free OBS Settings Generator</a>
        </div>

        <div style={{ textAlign: 'center', fontSize: 10, color: '#777', marginTop: 40, paddingBottom: 30 }} />
      </div>
    </Router>
  );
}

// Card Component
interface CardProps {
  emoji: string;
  hueA: number;
  hueB: number;
  i: number;
  service: string;
  description: string | React.JSX.Element;
}

function Card({ emoji, hueA, hueB, i, service, description }: CardProps) {
  const background = `linear-gradient(306deg, ${hue(hueA)}, ${hue(hueB)})`;
  return (
    <motion.div className={`card-container-${i}`} style={cardContainer} initial="offscreen" whileInView="onscreen" viewport={{ amount: 0.8 }}>
      <div style={{ ...splash, background }} />
      <motion.div style={card} variants={cardVariants} className="card">
        <div style={emojiStyle}>{emoji}</div>
        <div style={textStyle}>
          <h3>{service}</h3>
          <p>{description}</p>
        </div>
      </motion.div>
    </motion.div>
  );
}

// Variants and Styles
const cardVariants: Variants = {
  offscreen: { y: 300 },
  onscreen: { y: 50, rotate: -10, transition: { type: "spring", bounce: 0.4, duration: 0.8 } }
};

const hue = (h: number) => `hsl(${h},100%,50%)`;
const container = { margin: "100px auto", maxWidth: 500, paddingBottom: 150, width: "100%" } as const;
const missionSection = { textAlign: "center", marginBottom: 40, padding: "0 20px", color: "#333" } as const;
const cardContainer = { overflow: "hidden", display: "flex", justifyContent: "center", alignItems: "center", position: "relative", paddingTop: 20, marginBottom: -120 } as const;
const splash = { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, clipPath: `path("M 0 303.5 C 0 292.454 8.995 285.101 20 283.5 L 460 219.5 C 470.085 218.033 480 228.454 480 239.5 L 500 430 C 500 441.046 491.046 450 480 450 L 20 450 C 8.954 450 0 441.046 0 430 Z")` } as const;
const card = { fontSize: 164, width: 300, height: 430, display: "flex", justifyContent: "center", alignItems: "center", borderRadius: 20, background: "#f5f5f5", boxShadow: "0 0 1px hsl(0deg0%0%/0.075),0 0 2px hsl(0deg0%0%/0.075),0 0 4px hsl(0deg0%0%/0.075),0 0 8px hsl(0deg0%0%/0.075),0 0 16px hsl(0deg0%0%/0.075)", transformOrigin: "10% 60%" } as const;
const emojiStyle = { fontSize: "100px", marginBottom: "20px" } as const;
const textStyle = { textAlign: "center", color: "#333", fontSize: "14px", fontWeight: "bold" } as const;
const showPaymentButtonStyle = { padding: "10px 20px", marginTop: "20px", backgroundColor: "#0070f3", color: "white", border: "none", borderRadius: "5px", cursor: "pointer", fontSize: "16px", fontWeight: "bold" } as const;
const paymentPageContainerStyle = { marginTop: "100px", display: "flex", justifyContent: "center" } as const;

// Services updated for AI Solutions Architect
const services: [string, number, number, string, string | React.JSX.Element][] = [
  ["🤖", 340, 10, "AI Agents", "Custom AI agents to automate business workflows and verify data."],
  ["💻", 20, 40, "System Integration", "Connect your apps, databases, and services with smart automation."],
  ["📊", 60, 90, "Data Analytics", "AI-driven analysis to provide actionable insights and predictive models."],
  ["⚙️", 60, 90, "Workflow Automation", "Streamline repetitive processes and reduce human errors with AI orchestration."],
  ["🔐", 100, 200, "Security & Compliance", "Implement AI solutions that respect privacy, compliance, and company policies."],
  ["🌐", 290, 320, "Cloud & Deployment", "Deploy scalable AI systems on cloud platforms with minimal downtime."],
  ["📈", 80, 120, "Business Optimization", "Optimize operations and resource allocation with AI-driven decisions."],
  ["🧑‍💼", 0, 330, "Consulting & Training", <Link to="/ai-projects">Guidance and hands-on training for your team to implement AI solutions.</Link>],
];