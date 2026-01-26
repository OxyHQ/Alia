import * as React from "react"

interface User {
  id: string
  email?: string
  name?: string
  [key: string]: any
}

interface AuthContextType {
  isAuthenticated: boolean
  user: User | null
  isLoading: boolean
  signIn: () => Promise<void>
  signOut: () => void
  refreshUser: () => Promise<void>
}

const AuthContext = React.createContext<AuthContextType | undefined>(undefined)

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = React.useState(false)
  const [user, setUser] = React.useState<User | null>(null)
  const [isLoading, setIsLoading] = React.useState(true)

  const refreshUser = React.useCallback(async () => {
    try {
      const userInfo = await window.api.getUserInfo()
      if (userInfo) {
        setUser(userInfo)
        setIsAuthenticated(true)
      } else {
        setUser(null)
        setIsAuthenticated(false)
      }
    } catch (error) {
      console.error("Failed to fetch user info:", error)
      setUser(null)
      setIsAuthenticated(false)
    }
  }, [])

  const signIn = React.useCallback(async () => {
    await window.api.signIn()
  }, [])

  const signOut = React.useCallback(() => {
    window.api.signOut()
    setIsAuthenticated(false)
    setUser(null)
  }, [])

  // Initialize auth state on mount
  React.useEffect(() => {
    const initAuth = async () => {
      try {
        const authState = await window.api.getAuthState()
        if (authState.isAuthenticated) {
          await refreshUser()
        }
      } catch (error) {
        console.error("Failed to initialize auth:", error)
      } finally {
        setIsLoading(false)
      }
    }

    initAuth()
  }, [refreshUser])

  // Listen for auth events
  React.useEffect(() => {
    const unsubscribeSuccess = window.api.onAuthSuccess(({ userInfo }) => {
      setUser(userInfo)
      setIsAuthenticated(true)
    })

    const unsubscribeError = window.api.onAuthError(({ message }) => {
      console.error("Auth error:", message)
    })

    const unsubscribeSignedOut = window.api.onAuthSignedOut(() => {
      setUser(null)
      setIsAuthenticated(false)
    })

    return () => {
      unsubscribeSuccess()
      unsubscribeError()
      unsubscribeSignedOut()
    }
  }, [])

  const value = React.useMemo(
    () => ({
      isAuthenticated,
      user,
      isLoading,
      signIn,
      signOut,
      refreshUser,
    }),
    [isAuthenticated, user, isLoading, signIn, signOut, refreshUser]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = React.useContext(AuthContext)
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider")
  }
  return context
}
