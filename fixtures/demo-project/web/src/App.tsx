import { useEffect, useState } from "react";

const API = import.meta.env.VITE_API_URL || "http://localhost:3001";

type Item = { id: number; title: string; createdAt: string };

export function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem("token"));
  const [email, setEmail] = useState("demo@example.com");
  const [password, setPassword] = useState("password");
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function loadItems(t: string) {
    const res = await fetch(`${API}/api/items`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (!res.ok) throw new Error("Failed to load items");
    const data = (await res.json()) as { items: Item[] };
    setItems(data.items);
  }

  useEffect(() => {
    if (!token) return;
    loadItems(token).catch((e) => setError(String(e)));
  }, [token]);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(`${API}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      setError("Invalid credentials");
      return;
    }
    const data = (await res.json()) as { token: string };
    localStorage.setItem("token", data.token);
    setToken(data.token);
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    if (!token) return;
    setError(null);
    const res = await fetch(`${API}/api/items`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      setError("Could not create item");
      return;
    }
    setTitle("");
    await loadItems(token);
  }

  function logout() {
    localStorage.removeItem("token");
    setToken(null);
    setItems([]);
  }

  if (!token) {
    return (
      <main>
        <h1>Demo Items</h1>
        <form onSubmit={login} data-testid="login-form">
          <input
            data-testid="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            type="email"
          />
          <input
            data-testid="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            type="password"
          />
          <button type="submit" data-testid="login-submit">
            Sign in
          </button>
        </form>
        {error && <p className="error">{error}</p>}
      </main>
    );
  }

  return (
    <main>
      <h1>Your items</h1>
      <button type="button" onClick={logout} data-testid="logout">
        Log out
      </button>
      <ul data-testid="item-list">
        {items.map((it) => (
          <li key={it.id} data-testid="item">
            {it.title}
          </li>
        ))}
      </ul>
      <form onSubmit={addItem} data-testid="add-form">
        <input
          data-testid="new-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New item title"
        />
        <button type="submit" data-testid="add-submit">
          Add
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </main>
  );
}
