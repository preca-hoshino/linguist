import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Generates page numbers for pagination with ellipsis.
 */
export function getPageNumbers(currentPage: number, totalPages: number): (number | "...")[] {
  const pageNumbers: (number | "...")[] = [];
  const maxVisiblePages = 5;

  if (totalPages <= maxVisiblePages) {
    for (let i = 1; i <= totalPages; i += 1) {
      pageNumbers.push(i);
    }
    return pageNumbers;
  }

  pageNumbers.push(1);

  if (currentPage <= 3) {
    for (let i = 2; i <= 4; i += 1) {
      pageNumbers.push(i);
    }
    pageNumbers.push("...", totalPages);
  } else if (currentPage >= totalPages - 2) {
    pageNumbers.push("...");
    for (let i = totalPages - 3; i <= totalPages; i += 1) {
      pageNumbers.push(i);
    }
  } else {
    pageNumbers.push("...");
    for (let i = currentPage - 1; i <= currentPage + 1; i += 1) {
      pageNumbers.push(i);
    }
    pageNumbers.push("...", totalPages);
  }

  return pageNumbers;
}
