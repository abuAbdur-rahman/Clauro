/** Time-based greeting in our own words — never a name, never a logo (D39). */
export function greetingForHour(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export function HomeGreeting({ hour }: { hour: number }) {
  return (
    <h1 className="text-center font-serif text-3xl text-neutral-100">
      {greetingForHour(hour)}
    </h1>
  );
}
