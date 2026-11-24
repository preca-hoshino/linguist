import { useEffect, useRef, useState } from "react";
import type { SubmitEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { BillingError, billingError, getPrices, getReferenceRate, savePrice } from "./api";
import type { PriceTier } from "./api";

const blankTier = (minInputTokens: number): PriceTier => ({
  minInputTokens, inputPrice: "", outputPrice: "", cacheReadPrice: null,
  cacheWriteMode: "separate", cacheWritePrice: "0",
});

function convertedPrice(value: string | null, rate: string): string | null {
  if (value === null || value.length > 32 || rate.length > 64 || !/^\d+(?:\.\d+)?$/.test(value) || !/^\d+(?:\.\d+)?$/.test(rate)) return null;
  const [amountWhole, amountFraction = ""] = value.split(".");
  const [rateWhole, rateFraction = ""] = rate.split(".");
  const scale = amountFraction.length + rateFraction.length;
  const product = (BigInt(`${amountWhole}${amountFraction}`) * BigInt(`${rateWhole}${rateFraction}`)).toString();
  if (scale === 0) return product;
  const digits = product.padStart(scale + 1, "0");
  const integer = digits.slice(0, -scale);
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

function PricePreview({ value, reference }: {
  value: string | null;
  reference: { currency: string; target: string; rate: string; date: string | null } | null;
}) {
  if (!reference || reference.currency === reference.target) return null;
  const converted = convertedPrice(value, reference.rate);
  return converted === null ? null : <span>≈ {reference.target} {converted}</span>;
}

interface Props {
  providerId: string;
  modelId: string;
  name: string;
  onClose: () => void;
  onSaved: () => void;
}

export function PriceDialog({ providerId, modelId, name, onClose, onSaved }: Props) {
  const { csrfToken, handleUnauthorized } = useAuth();
  const dialog = useRef<HTMLDialogElement>(null);
  const [tiers, setTiers] = useState<PriceTier[]>([blankTier(0)]);
  const [currency, setCurrency] = useState("USD");
  const [source, setSource] = useState("");
  const [maxInputTokens, setMaxInputTokens] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadedPrice, setLoadedPrice] = useState<{ providerId: string; modelId: string } | null>(null);
  const [reference, setReference] = useState<{ currency: string; target: string; rate: string; date: string | null } | null>(null);
  const priceLoaded = loadedPrice?.providerId === providerId && loadedPrice.modelId === modelId;

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    const controller = new AbortController();
    void getPrices(providerId, modelId, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.item) {
        setTiers(result.item.tiers);
        setCurrency(result.item.currency);
        setSource(result.item.source);
        setMaxInputTokens(result.item.maxInputTokens ?? null);
      }
      setLoadedPrice({ providerId, modelId });
    })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        if (reason instanceof BillingError && reason.status === 401) {
          handleUnauthorized();
          return;
        }
        setError(billingError(reason));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); };
  }, [providerId, modelId, handleUnauthorized]);

  useEffect(() => {
    if (!/^[A-Z]{3}$/.test(currency)) return undefined;
    const controller = new AbortController();
    void getReferenceRate(currency, controller.signal).then((result) => {
      setReference(result.target && result.rate ? { currency, target: result.target, rate: result.rate, date: result.date } : null);
    }).catch((reason: unknown) => {
      if (controller.signal.aborted) return;
      if (reason instanceof BillingError && reason.status === 401) {
        handleUnauthorized();
        return;
      }
      setError(billingError(reason));
    });
    return () => { controller.abort(); };
  }, [currency, handleUnauthorized]);

  function changeTier(index: number, patch: Partial<PriceTier>) {
    setTiers((current) => current.map((tier, position) => position === index ? { ...tier, ...patch } : tier));
  }

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!priceLoaded || saving) return;
    if (tiers.some((tier, index) => index > 0 && tier.minInputTokens <= (tiers[index - 1]?.minInputTokens ?? -1))) {
      setError("请按递增顺序填写分档");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await savePrice({ providerId, modelId, currency, source, maxInputTokens, tiers }, csrfToken, new AbortController().signal);
      onSaved();
      dialog.current?.close();
    } catch (reason) {
      if (reason instanceof BillingError && reason.status === 401) {
        handleUnauthorized();
        return;
      }
      setError(billingError(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialog} className="catalog-dialog billing-price-dialog" aria-labelledby="price-dialog-title" onClose={onClose}
      onKeyDown={(event) => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.currentTarget.close(); } }}>
      <header className="catalog-dialog-header">
        <div><h2 id="price-dialog-title">模型价格</h2><span className="catalog-dialog-name">{name} · {providerId} / {modelId}</span></div>
      </header>
      <form onSubmit={(event) => { void submit(event); }}>
        <div className="catalog-dialog-body">
          {loading ? <p role="status">加载中…</p> : null}
          {error ? <div className="error-banner" role="alert">{error}</div> : null}
          <div className="catalog-fields">
            <label className="catalog-field">原币代码<input className="select-control" value={currency} onChange={(event) => { setCurrency(event.target.value.toUpperCase()); }} pattern="[A-Z]{3}" maxLength={3} required /></label>
            <label className="catalog-field">价格来源<input className="select-control" value={source} onChange={(event) => { setSource(event.target.value); }} maxLength={500} /></label>
            <label className="catalog-field">最大输入 Token（含）<input className="select-control" type="number" min="0" step="1" placeholder="不限制" value={maxInputTokens ?? ""} onChange={(event) => { setMaxInputTokens(event.target.value === "" ? null : Number(event.target.value)); }} /></label>
          </div>
          <div className="billing-tier-heading"><h3>价格分档（每百万 Token）</h3></div>
          {reference && reference.currency === currency && reference.currency !== reference.target ? <p>参考汇率：1 {reference.currency} ≈ {reference.rate} {reference.target}{reference.date ? ` · ${reference.date}` : ""}</p> : null}
          {tiers.map((tier, index) => (
            <fieldset className="catalog-fieldset billing-tier" key={index}>
              <legend>第 {index + 1} 档{tiers[index + 1] ? ` · 小于 ${tiers[index + 1]?.minInputTokens.toLocaleString()} Token` : maxInputTokens === null ? " · 无上限" : ` · 最多 ${maxInputTokens.toLocaleString()} Token`}</legend>
              <div className="catalog-fields">
                <label className="catalog-field">起始输入 Token<input className="select-control" type="number" min={index === 0 ? 0 : 1} step="1" value={tier.minInputTokens} disabled={index === 0} onChange={(event) => { changeTier(index, { minInputTokens: Number(event.target.value) }); }} required /></label>
                <label className="catalog-field">普通输入<input className="select-control" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" value={tier.inputPrice} onChange={(event) => { changeTier(index, { inputPrice: event.target.value }); }} required /><PricePreview value={tier.inputPrice} reference={reference?.currency === currency ? reference : null} /></label>
                <label className="catalog-field">输出<input className="select-control" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" value={tier.outputPrice} onChange={(event) => { changeTier(index, { outputPrice: event.target.value }); }} required /><PricePreview value={tier.outputPrice} reference={reference?.currency === currency ? reference : null} /></label>
                <label className="catalog-field">缓存读取<input className="select-control" inputMode="decimal" placeholder="同普通输入价" pattern="[0-9]+([.][0-9]{1,6})?" value={tier.cacheReadPrice ?? ""} onChange={(event) => { changeTier(index, { cacheReadPrice: event.target.value || null }); }} /><PricePreview value={tier.cacheReadPrice ?? tier.inputPrice} reference={reference?.currency === currency ? reference : null} /></label>
                <label className="catalog-field">缓存写入计价<select className="select-control" value={tier.cacheWriteMode} onChange={(event) => { const value = event.target.value; if (value === "input" || value === "separate" || value === "unsupported") changeTier(index, { cacheWriteMode: value }); }}><option value="input">按普通输入计价</option><option value="separate">单独计价</option><option value="unsupported">暂不支持</option></select></label>
                {tier.cacheWriteMode === "separate" ? <label className="catalog-field">缓存写入<input className="select-control" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,6})?" value={tier.cacheWritePrice ?? ""} onChange={(event) => { changeTier(index, { cacheWritePrice: event.target.value || null }); }} required /><PricePreview value={tier.cacheWritePrice} reference={reference?.currency === currency ? reference : null} /></label> : null}
              </div>
              {index > 0 ? <button className="btn-control" type="button" onClick={() => { setTiers((current) => current.filter((_, position) => position !== index)); }}>删除此档</button> : null}
            </fieldset>
          ))}
          <button className="btn-control" type="button" onClick={() => { setTiers((current) => [...current, blankTier((current[current.length - 1]?.minInputTokens ?? 0) + 1)]); }}>增加档位</button>
        </div>
        <footer className="catalog-dialog-footer"><button className="btn-control" type="button" onClick={() => { dialog.current?.close(); }}>关闭</button><button className="btn-control" disabled={saving || loading || !priceLoaded} type="submit">保存价格</button></footer>
      </form>
    </dialog>
  );
}
