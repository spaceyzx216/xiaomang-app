import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { apiUrl, parseApiJson } from "./api";
import { clearStageDrafts } from "./stageDraft";

export type AuthRole = "manager" | "employee";

export type AuthUser = {
  id: string;
  _id: string;
  name: string;
  email?: string;
  account?: string;
  department?: string;
  employeeId?: string;
  role: AuthRole;
};

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  login: (login: string, password: string) => Promise<AuthUser>;
  registerManager: (payload: { name: string; email: string; password: string; inviteCode: string }) => Promise<AuthUser>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const AUTH_USER_ID_KEY = "xm_auth_user_id";
const WORKSPACE_KEYS = [
  "contentTasks",
  "selectedTopics",
  "selectedTopicIds",
  "tikhubResults",
  "topicFetchContext",
  "contentAutoRunKey",
  "contentActiveGroupIndex",
  "sourcePlatform",
  "sourcePlatformUserLocked",
  "finalDraftPayload",
  "contentWorkflowFailures",
  "contentWorkflowFallbackNotes",
  "contentWorkflowGroups",
  "workflowRawDone",
  "contentAutoRunConsumedKey",
  "contentCustomerId",
];

const clearWorkspaceState = () => {
  if (typeof window === "undefined") return;
  WORKSPACE_KEYS.forEach(key => sessionStorage.removeItem(key));
  // 阶段草稿里存着上一个人的分析结果和输入，退出登录必须一起清掉。
  clearStageDrafts();
};

const requestAuth = async (path: string, init: RequestInit = {}) => {
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await parseApiJson(response);
  if (!response.ok || data?.success === false) {
    if (response.status === 401 && typeof window !== "undefined") {
      window.dispatchEvent(new Event("auth:logout"));
    }
    throw new Error(String(data?.error || "认证请求失败"));
  }
  return data;
};

export const authAPI = {
  login: async (login: string, password: string) => {
    const data = await requestAuth("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ login, password }),
    });
    return data.user as AuthUser;
  },
  registerManager: async (payload: { name: string; email: string; password: string; inviteCode: string }) => {
    const data = await requestAuth("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return data.user as AuthUser;
  },
  me: async () => {
    const data = await requestAuth("/api/auth/me", { method: "GET" });
    return data.user as AuthUser;
  },
  logout: async () => {
    await requestAuth("/api/auth/logout", { method: "POST" });
  },
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    authAPI.me()
      .then(nextUser => {
        if (active) {
          const previousUserId = sessionStorage.getItem(AUTH_USER_ID_KEY) || "";
          if (previousUserId && previousUserId !== nextUser.id) clearWorkspaceState();
          sessionStorage.setItem(AUTH_USER_ID_KEY, nextUser.id);
          setUser(nextUser);
        }
      })
      .catch(() => {
        if (active) {
          clearWorkspaceState();
          sessionStorage.removeItem(AUTH_USER_ID_KEY);
          setUser(null);
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    const handleLogout = () => {
      clearWorkspaceState();
      sessionStorage.removeItem(AUTH_USER_ID_KEY);
      setUser(null);
    };
    window.addEventListener("auth:logout", handleLogout);
    return () => {
      active = false;
      window.removeEventListener("auth:logout", handleLogout);
    };
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    user,
    loading,
    login: async (login, password) => {
      const nextUser = await authAPI.login(login, password);
      clearWorkspaceState();
      sessionStorage.setItem(AUTH_USER_ID_KEY, nextUser.id);
      setUser(nextUser);
      return nextUser;
    },
    registerManager: async payload => {
      const nextUser = await authAPI.registerManager(payload);
      clearWorkspaceState();
      sessionStorage.setItem(AUTH_USER_ID_KEY, nextUser.id);
      setUser(nextUser);
      return nextUser;
    },
    logout: async () => {
      try {
        await authAPI.logout();
      } finally {
        clearWorkspaceState();
        sessionStorage.removeItem(AUTH_USER_ID_KEY);
        setUser(null);
      }
    },
  }), [loading, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

function AuthLoading() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f7fb] text-slate-600">
      <div className="flex items-center gap-3 text-sm"><span className="h-2.5 w-2.5 animate-pulse rounded-full bg-blue-600" />正在验证登录状态…</div>
    </main>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <AuthLoading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

export function RequireRole({ role, children }: { role: AuthRole; children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <AuthLoading />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={user.role === "manager" ? "/manager" : "/"} replace />;
  return <>{children}</>;
}

export function PublicOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <AuthLoading />;
  if (user) return <Navigate to={user.role === "manager" ? "/manager" : "/"} replace />;
  return <>{children}</>;
}

export function RoleHome() {
  const { user, loading } = useAuth();
  if (loading) return <AuthLoading />;
  return <Navigate to={user?.role === "manager" ? "/manager" : "/"} replace />;
}
