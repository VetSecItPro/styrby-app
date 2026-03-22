/**
 * Article: Why We Chose Supabase Over Firebase
 * Category: technical
 */
export default function WhySupabaseOverFirebase() {
  return (
    <>
      <p>
        Styrby&apos;s backend runs on Supabase. We evaluated Firebase as the
        primary alternative. Both are capable platforms, but they make
        fundamentally different tradeoffs. This article explains why Supabase
        was the better fit for our specific requirements and where Firebase
        would have been the better call.
      </p>

      <h2>Postgres vs. Firestore: The Data Model Question</h2>
      <p>
        Firebase uses Firestore, a document database. Supabase uses PostgreSQL,
        a relational database. The choice depends on your data structure.
      </p>
      <p>
        Styrby&apos;s data is relational. Sessions belong to users. Messages
        belong to sessions. Cost records reference sessions and users. Budget
        alerts apply to users, projects, or agents. These relationships are
        natural in SQL:
      </p>
      <pre>
        <code>{`-- Get total cost per agent for a user this month
SELECT agent_type, SUM(total_cost_usd) as total
FROM cost_records
WHERE user_id = $1
  AND recorded_at >= date_trunc('month', now())
GROUP BY agent_type;`}</code>
      </pre>
      <p>
        In Firestore, this query requires either denormalized data (storing the
        agent type redundantly in the cost record) or a client-side join.
        Denormalization works but means updating multiple documents when a
        single fact changes. Client-side joins mean more bandwidth and slower
        queries. For analytics queries like cost aggregation and budget
        tracking, SQL is both more natural and more efficient.
      </p>

      <h2>Row-Level Security vs. Firestore Rules</h2>
      <p>
        Both platforms provide server-side authorization rules that enforce
        data access without trusting the client.
      </p>
      <p>
        Supabase uses PostgreSQL&apos;s Row-Level Security (RLS):
      </p>
      <pre>
        <code>{`-- Users can only read their own sessions
CREATE POLICY "Users read own sessions"
  ON sessions FOR SELECT
  USING (user_id = (SELECT auth.uid()));

-- Users can only read their own cost records
CREATE POLICY "Users read own costs"
  ON cost_records FOR SELECT
  USING (user_id = (SELECT auth.uid()));`}</code>
      </pre>
      <p>
        Firebase uses Firestore Security Rules:
      </p>
      <pre>
        <code>{`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /sessions/{sessionId} {
      allow read: if request.auth.uid == resource.data.userId;
    }
    match /costRecords/{recordId} {
      allow read: if request.auth.uid == resource.data.userId;
    }
  }
}`}</code>
      </pre>
      <p>
        Both work. The difference is testability and composability. RLS
        policies are SQL, so they can be tested with standard database testing
        tools. They compose naturally with complex queries: the policy applies
        automatically regardless of how the query is structured.
      </p>
      <p>
        Firestore rules are a custom DSL. They are tested with the Firebase
        emulator, which requires a separate setup. Complex authorization logic
        (e.g., team-based access where a user can see team members&apos; data)
        is harder to express in the rules DSL than in SQL.
      </p>

      <h2>Realtime Subscriptions</h2>
      <p>
        Both platforms support real-time data subscriptions. Styrby uses
        real-time updates for live session monitoring and permission
        notifications. Cost analytics load from materialized views on each page
        visit.
      </p>
      <p>
        Supabase Realtime uses PostgreSQL&apos;s WAL (Write-Ahead Log) to
        broadcast changes:
      </p>
      <pre>
        <code>{`import { createClient } from "@supabase/supabase-js";

const supabase = createClient(url, anonKey);

supabase
  .channel("session-updates")
  .on(
    "postgres_changes",
    {
      event: "UPDATE",
      schema: "public",
      table: "sessions",
      filter: \`user_id=eq.\${userId}\`,
    },
    (payload) => {
      // Handle session update
      updateSessionUI(payload.new);
    }
  )
  .subscribe();`}</code>
      </pre>
      <p>
        Firebase&apos;s real-time listeners are arguably simpler to set up and
        have a longer track record of reliability at scale. This is one area
        where Firebase has a clear advantage. Supabase Realtime has improved
        significantly but is newer and has less battle-testing at very high
        connection counts.
      </p>

      <h2>The Self-Host Option</h2>
      <p>
        Supabase is open source. You can self-host the entire stack: Postgres,
        Auth, Realtime, Storage, and Edge Functions. This matters for two
        scenarios:
      </p>
      <ul>
        <li>
          <strong>Enterprise customers</strong> who require data to stay on
          their infrastructure.
        </li>
        <li>
          <strong>Vendor risk mitigation.</strong> If Supabase (the company)
          disappears, the software continues to work.
        </li>
      </ul>
      <p>
        Firebase is proprietary. You cannot self-host it. If Google
        discontinues Firebase (unlikely but not impossible, given Google&apos;s
        track record with products), migration is a significant effort.
      </p>
      <p>
        We do not self-host today. We use Supabase&apos;s managed cloud. But
        the option influenced the decision because it reduces long-term vendor
        lock-in.
      </p>

      <h2>Where Firebase Would Have Won</h2>
      <p>
        In fairness, Firebase has advantages we weighed:
      </p>
      <ul>
        <li>
          <strong>Maturity.</strong> Firebase has been in production since
          2014. Supabase launched in 2020. Firebase&apos;s edge cases are
          better documented.
        </li>
        <li>
          <strong>Ecosystem.</strong> Firebase integrates tightly with Google
          Cloud, Cloud Functions, and other GCP services. If we were already
          on GCP, Firebase would be more natural.
        </li>
        <li>
          <strong>Offline persistence.</strong> Firestore&apos;s client-side
          caching and offline persistence are built in and well-tested. We
          implemented our own offline layer with SQLite, which took engineering
          time.
        </li>
        <li>
          <strong>Scale track record.</strong> Firebase handles millions of
          concurrent connections. Supabase is growing but has not been tested
          at the same scale publicly.
        </li>
      </ul>

      <h2>The Decision Framework</h2>
      <p>
        Choose Supabase when: your data is relational, you want SQL for
        analytics, you value the self-host option, or you need PostgreSQL
        features (BRIN indexes, materialized views, CTEs).
      </p>
      <p>
        Choose Firebase when: your data is document-shaped, you need proven
        scale, you are already on GCP, or you want built-in offline persistence
        without building your own sync layer.
      </p>
      <p>
        For Styrby, the relational data model and SQL analytics capabilities
        were the deciding factors. Cost tracking and budget alerts are
        fundamentally relational problems, and PostgreSQL handles them better
        than a document store.
      </p>
    </>
  );
}
