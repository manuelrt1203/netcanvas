-- Supprime un examen et toutes ses copies. Même contrôle d'accès que set_exam_closed :
-- jeton de suivi (empreinte SHA-256) ou propriétaire connecté. Irréversible.
create or replace function public.delete_exam(p_id text, p_token text)
returns void
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if not netcanvas_private.can_admin_exam(p_id, p_token) then raise exception 'lien de suivi invalide'; end if;
  delete from public.exam_submissions s where s.exam_id = p_id;
  delete from public.exams e where e.id = p_id;
end;
$function$;

revoke all on function public.delete_exam(text, text) from public;
grant execute on function public.delete_exam(text, text) to anon, authenticated;
