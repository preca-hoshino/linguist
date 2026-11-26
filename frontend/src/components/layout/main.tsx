import { cn } from "@/lib/utils";

type MainProps = React.HTMLAttributes<HTMLElement> & {
  fixed?: boolean;
  fluid?: boolean;
};

export function Main({ fixed, className, fluid, ...props }: MainProps) {
  return (
    <main
      id="content"
      tabIndex={-1}
      data-layout={fixed ? "fixed" : "auto"}
      className={cn(
        "px-4 py-6 sm:px-6",
        fixed && "flex grow flex-col overflow-hidden",
        !fluid && "@7xl/content:mx-auto @7xl/content:w-full @7xl/content:max-w-7xl",
        className,
      )}
      {...props}
    />
  );
}
