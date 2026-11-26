import { createContext, useContext, useEffect, useState } from "react";
import { CommandMenu } from "@/components/command-menu";

interface SearchContextType {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  dryRunOpen: boolean;
  setDryRunOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

const SearchContext = createContext<SearchContextType | null>(null);

export function SearchProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [dryRunOpen, setDryRunOpen] = useState(false);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", down);
    return () => {
      document.removeEventListener("keydown", down);
    };
  }, []);

  return (
    <SearchContext value={{ open, setOpen, dryRunOpen, setDryRunOpen }}>
      {children}
      <CommandMenu />
    </SearchContext>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useSearch(): SearchContextType {
  const context = useContext(SearchContext);
  if (!context) {
    throw new Error("useSearch must be used within SearchProvider");
  }
  return context;
}
