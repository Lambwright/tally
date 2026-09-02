import { useCallback, useEffect, useState } from "react";
import { getStoredToken, verify, logout as doLogout } from "./auth.js";
import { api } from "./api.js";
import Header from "./components/Header.jsx";
import LoginScreen from "./components/LoginScreen.jsx";
import QueueList from "./components/QueueList.jsx";
import SubmissionDetail from "./components/SubmissionDetail.jsx";

const STATUSES = [
  { key: "needs_review", label: "Needs Review" },
  { key: "needs_revision", label: "Needs Revision" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

// Selection state lives in the URL hash, not a router — keeps this app easy to
// mount inside a future shared shell without dragging in absolute-path routing.
function getHashId() {
  const m = window.location.hash.match(/^#\/submission\/([0-9a-f-]{36})$/i);
  return m ? m[1] : null;
}

export default function App() {
  const [authState, setAuthState] = useState("checking"); // checking | out | in
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState("needs_review");
  const [submissions, setSubmissions] = useState([]);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState(null);
  const [selectedId, setSelectedId] = useState(getHashId());

  useEffect(() => {
    const token = getStoredToken();
    if (!token) {
      setAuthState("out");
      return;
    }
    verify(token).then((data) => {
      if (data.valid) {
        setUser(data.user);
        setAuthState("in");
      } else {
        setAuthState("out");
      }
    });
  }, []);

  useEffect(() => {
    const onHash = () => setSelectedId(getHashId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const loadList = useCallback(() => {
    if (authState !== "in") return;
    setLoadingList(true);
    setListError(null);
    api
      .listSubmissions(status)
      .then((data) => setSubmissions(data.submissions || []))
      .catch((e) => {
        if (e.unauthorized) setAuthState("out");
        else setListError(e.message);
      })
      .finally(() => setLoadingList(false));
  }, [status, authState]);

  useEffect(() => {
    loadList();
  }, [loadList]);

  function selectSubmission(id) {
    window.location.hash = id ? `#/submission/${id}` : "";
  }

  function handleLoggedIn(u) {
    setUser(u);
    setAuthState("in");
  }
  function handleLogout() {
    doLogout();
    setUser(null);
    setAuthState("out");
  }

  if (authState === "checking") {
    return (
      <div className="login-screen">
        <span className="spinner-inline">Checking session…</span>
      </div>
    );
  }
  if (authState === "out") {
    return <LoginScreen onLoggedIn={handleLoggedIn} />;
  }

  return (
    <>
      <Header user={user} onLogout={handleLogout} />
      <div className="container">
        {selectedId ? (
          <SubmissionDetail id={selectedId} onClose={() => selectSubmission(null)} onChanged={loadList} />
        ) : (
          <>
            <div className="tabs">
              {STATUSES.map((s) => (
                <button
                  key={s.key}
                  className={`tab ${status === s.key ? "active" : ""}`}
                  onClick={() => setStatus(s.key)}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {listError && <div className="card" style={{ color: "var(--red)" }}>{listError}</div>}
            <QueueList submissions={submissions} loading={loadingList} onSelect={selectSubmission} />
          </>
        )}
      </div>
    </>
  );
}
